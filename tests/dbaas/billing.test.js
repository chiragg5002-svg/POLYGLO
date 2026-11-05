const request = require("supertest");
const { buildTestApp } = require("./_app");
const {
  aggregateUsageRows, buildUsageLines, bytesToGb, chargePaise, formatInrPaise, renderInvoicePdf,
  billedMonths,
} = require("../../dbaas/billing");

describe("billing arithmetic and documents", () => {
  test("calculates INR paise with integer rounding and usage quantities", () => {
    expect(chargePaise("1.000000", "2000")).toBe(2000n);
    expect(chargePaise("100000", "500", "100000")).toBe(500n);
    expect(chargePaise("0.500000", "1000")).toBe(500n);
    expect(bytesToGb("500000000")).toBe("0.500000");
    expect(formatInrPaise(123456n)).toBe("₹1,234.56");
    const result = buildUsageLines({
      apiRequests: "100000", outboundBytes: "500000000", storageGbMonth: "1.000000",
    }, {
      storage_paise_per_gb_month: "2000",
      requests_per_unit: "100000",
      request_unit_paise: "500",
      transfer_paise_per_gb: "1000",
    }, "2026-10-01 to 2026-10-02");
    expect(result.lines.map((line) => line.amountPaise)).toEqual(["2000", "500", "500"]);
    expect(result.subtotalPaise).toBe("3000");
  });

  test("aggregates daily measurements and marks missing measurements unavailable", () => {
    const rows = [
      { usage_date: "2026-10-01", api_requests: "10", outbound_bytes: "100", transfer_available: true, storage_bytes: "1000000000", storage_available: true },
      { usage_date: "2026-10-02", api_requests: "20", outbound_bytes: "200", transfer_available: true, storage_bytes: "1000000000", storage_available: true },
    ];
    expect(aggregateUsageRows({
      projects: [{ project_id: "proj_a", created_at: "2026-10-01T00:00:00.000Z" }],
      daily: rows, periodStart: "2026-10-01", periodEnd: "2026-10-02",
    })).toMatchObject({
      apiRequests: "30", outboundBytes: "300", storageGbMonth: "0.064516",
      transferAvailable: true, storageAvailable: true,
    });
    const missing = aggregateUsageRows({
      projects: [{ project_id: "proj_a", created_at: "2026-10-01T00:00:00.000Z" }],
      daily: [{ ...rows[0], storage_bytes: null, storage_available: false }],
      periodStart: "2026-10-01", periodEnd: "2026-10-02",
    });
    expect(missing.storageAvailable).toBe(false);
    expect(missing.storageGbMonth).toBeNull();
    expect(missing.actualDailyRows).toBeLessThan(missing.expectedStorageSnapshots);
  });

  test("prorates storage GB-month across actual calendar days", () => {
    const daily = Array.from({ length: 31 }, (_, day) => ({
      usage_date: `2026-10-${String(day + 1).padStart(2, "0")}`,
      api_requests: 0, outbound_bytes: 0, transfer_available: true,
      storage_bytes: "1000000000", storage_available: true,
    }));
    expect(aggregateUsageRows({
      projects: [{ project_id: "proj_a", created_at: "2026-10-01T00:00:00.000Z" }],
      daily, periodStart: "2026-10-01", periodEnd: "2026-10-31",
    }).storageGbMonth).toBe("1.000000");
    expect(aggregateUsageRows({
      projects: [{ project_id: "proj_a", created_at: "2026-10-01T00:00:00.000Z" }],
      daily: daily.slice(0, 1), periodStart: "2026-10-01", periodEnd: "2026-10-01",
    }).storageGbMonth).toBe("0.032258");
  });

  test("prorates monthly plan fees across calendar months", () => {
    expect(billedMonths("2026-10-01 to 2026-10-31")).toBe("1.000000");
    expect(billedMonths("2026-10-16 to 2026-10-31")).toBe("0.516129");
    const result = buildUsageLines({
      apiRequests: "0", outboundBytes: "0", storageGbMonth: "0.000000",
    }, {
      name: "Pro", monthly_fee_paise: "3100", storage_paise_per_gb_month: "0",
      requests_per_unit: "100000", request_unit_paise: "0", transfer_paise_per_gb: "0",
    }, "2026-10-01 to 2026-10-31");
    expect(result.lines[0]).toMatchObject({
      description: "Plan subscription", quantity: "1.000000", amountPaise: "3100",
    });
  });

  test("renders a PDF from a stored invoice snapshot", async () => {
    const pdf = await renderInvoicePdf({
      invoiceNumber: "MST-2026-000001", status: "issued", periodStart: "2026-10-01",
      periodEnd: "2026-10-31", dueDate: "2026-11-15", issuedAt: "2026-10-31T00:00:00.000Z",
      clientName: "Example Client", clientEmail: "client@example.test",
      subtotalPaise: "3000", taxPaise: "0", paidPaise: "0", amountDuePaise: "3000",
      items: [{
        description: "Database storage", service: "Database storage", quantity: "1.000000",
        unit: "GB-month", unitPricePaise: "2000", amountPaise: "2000", usagePeriod: "October",
      }],
    });
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe("billing API workflow", () => {
  let ctx;
  let app;
  beforeEach(() => {
    ctx = buildTestApp({
      operatorAuth(req, res, next) {
        if (req.get("x-test-operator") === "valid") return next();
        res.status(401).json({ success: false, message: "Operator credentials required." });
      },
    });
    app = ctx.app;
  });
  const operator = (method, path) => request(app)[method](path).set("X-Test-Operator", "valid");

  async function verifiedClient() {
    const agent = request.agent(app);
    await agent.post("/v1/client/auth/register").send({
      displayName: "Billing Client", email: "billing@example.test", password: "correct horse battery",
    });
    const login = await agent.post("/v1/client/auth/login").send({
      email: "billing@example.test", password: "correct horse battery",
    });
    expect(login.status).toBe(200);
    return agent;
  }

  test("meters authenticated requests, blocks unsupported invoices, issues snapshots, and tracks manual payments", async () => {
    const agent = await verifiedClient();
    const configuredPlan = await operator("put", "/v1/billing/plans/demo-inr-v1").send({
      name: "Test plan", storagePaisePerGbMonth: 2000, requestsPerUnit: 1,
      requestUnitPaise: 100000, transferPaisePerGb: 1000, active: true,
    });
    expect(configuredPlan.status).toBe(200);
    const account = await ctx.store.getClientByEmail("billing@example.test");
    ctx.store.clientBillingSubscriptions.get(account.client_id).plan_id = "demo-inr-v1";
    const project = await agent.post("/v1/client/projects").send({ name: "Billing project" });
    expect(project.status).toBe(201);
    const unsupported = await operator("post", "/v1/billing/invoices/drafts").send({
      clientId: account.client_id, periodStart: new Date().toISOString().slice(0, 10),
      periodEnd: new Date().toISOString().slice(0, 10),
    });
    expect(unsupported.status).toBe(409);
    const apiResponse = await request(app).get("/v1/usage").set({
      Authorization: `Bearer ${project.body.apiKey}`,
    });
    expect(apiResponse.status).toBe(200);
    expect((await request(app).get("/v1/client/billing/export.csv")).status).toBe(401);
    await new Promise((resolve) => setImmediate(resolve));
    const today = new Date().toISOString().slice(0, 10);

    const snapshot = await operator("post", "/v1/billing/storage-snapshots")
      .send({ date: today });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.snapshots[0]).toMatchObject({ projectId: project.body.projectId, available: true });
    const reconcile = await operator("post", "/v1/billing/reconcile")
      .send({ start: today, end: today });
    expect(reconcile.status).toBe(200);
    expect(reconcile.body.idempotent).toBe(true);

    const estimate = await agent.get("/v1/client/billing/usage");
    expect(estimate.status).toBe(200);
    expect(estimate.body.usage.apiRequests).toBe("1");
    expect(estimate.body.usage.storageAvailable).toBe(true);
    expect(estimate.body.estimatedCharges.complete).toBe(true);

    const draft = await operator("post", "/v1/billing/invoices/drafts").send({
      clientId: project.body.clientId || "client_000000000000000000000000",
      periodStart: today,
      periodEnd: today,
    });
    expect(draft.status).toBe(404);

    const validDraft = await operator("post", "/v1/billing/invoices/drafts").send({
      clientId: account.client_id, periodStart: today, periodEnd: today,
    });
    expect(validDraft.status).toBe(201);
    expect(validDraft.body.invoice.status).toBe("draft");
    const duplicate = await operator("post", "/v1/billing/invoices/drafts").send({
      clientId: account.client_id, periodStart: today, periodEnd: today,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.replayed).toBe(true);

    const invoiceId = validDraft.body.invoice.invoiceId;
    expect((await agent.get(`/v1/client/billing/invoices/${invoiceId}`)).status).toBe(200);
    expect((await agent.get(`/v1/client/billing/invoices/${invoiceId}/pdf`)).status).toBe(409);
    expect((await agent.post(`/v1/billing/invoices/${invoiceId}/issue`).send({ reason: "Not client authorized" })).status).toBe(401);
    expect((await operator("post", `/v1/billing/invoices/${invoiceId}/issue`)
      .send({ reason: "Cannot skip review", dueDate: today })).status).toBe(409);
    const reviewed = await operator("post", `/v1/billing/invoices/${invoiceId}/review`).send({
      reason: "Verified measured usage and pricing",
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.invoice.status).toBe("reviewed");
    const issued = await operator("post", `/v1/billing/invoices/${invoiceId}/issue`).send({
      reason: "Approved reviewed invoice", dueDate: today,
    });
    expect(issued.status).toBe(200);
    expect(issued.body.invoice.status).toBe("issued");
    const pdf = await agent.get(`/v1/client/billing/invoices/${invoiceId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");

    const payment = await operator("post", "/v1/billing/payments").send({
      invoiceId, amountPaise: String(BigInt(issued.body.invoice.amountDuePaise) / 2n || 1n), reference: "=SUM(1,1)",
    });
    expect(payment.status).toBe(201);
    expect(payment.body.invoice.status).toBe("partially_paid");
    expect((await agent.get("/v1/client/billing/payments")).body.payments).toHaveLength(1);
    const remaining = BigInt(payment.body.invoice.amountDuePaise) - BigInt(payment.body.invoice.paidPaise);
    const finalPayment = await operator("post", "/v1/billing/payments").send({
      invoiceId, amountPaise: remaining.toString(), reference: "manual-ref-2",
    });
    expect(finalPayment.status).toBe(201);
    expect(finalPayment.body.invoice.status).toBe("paid");
    const download = await agent.get("/v1/client/billing/export.csv");
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toContain("text/csv");
    expect(download.headers["content-disposition"]).toContain("maestro-my-billing.csv");
    expect(download.text).toContain("payment_record");
    expect(download.text).toContain("\"'=SUM(1,1)\"");
    expect(download.text).toContain("MST-");
  });

  test("lists plan prices and schedules an owned plan change for the next period", async () => {
    const alice = await verifiedClient();
    const bob = request.agent(app);
    await bob.post("/v1/client/auth/register").send({
      displayName: "Other Client", email: "other@example.test", password: "correct horse battery",
    });
    const login = await bob.post("/v1/client/auth/login").send({
      email: "other@example.test", password: "correct horse battery",
    });
    expect(login.status).toBe(200);

    expect((await request(app).get("/v1/client/billing/plans")).status).toBe(401);
    const plans = await alice.get("/v1/client/billing/plans");
    expect(plans.status).toBe(200);
    expect(plans.body.plans.map((plan) => plan.planId)).toEqual(
      expect.arrayContaining(["free", "pro", "enterprise"]),
    );
    expect(plans.body.plans.find((plan) => plan.planId === "pro").pricingConfigured).toBe(false);
    expect((await alice.put("/v1/client/billing/subscription").send({ planId: "pro" })).status).toBe(409);

    const configured = await operator("put", "/v1/billing/plans/pro").send({
      name: "Pro", monthlyFeePaise: 250000, storagePaisePerGbMonth: 1000,
      requestsPerUnit: 100000, requestUnitPaise: 250, transferPaisePerGb: 500,
      active: true, pricingConfigured: true,
    });
    expect(configured.status).toBe(200);
    const scheduled = await alice.put("/v1/client/billing/subscription").send({ planId: "pro" });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.subscription.planId).toBe("free");
    expect(scheduled.body.subscription.pendingPlanId).toBe("pro");
    expect(scheduled.body.subscription.pendingEffectiveAt).toBeTruthy();

    const aliceUsage = await alice.get("/v1/client/billing/usage");
    const bobUsage = await bob.get("/v1/client/billing/usage");
    expect(aliceUsage.body.plan.planId).toBe("free");
    expect(aliceUsage.body.pendingPlan.planId).toBe("pro");
    expect(bobUsage.body.plan.planId).toBe("free");
    expect(bobUsage.body.pendingPlan).toBeNull();
    expect(bobUsage.body.estimatedCharges.monthlyFeePaise).toBe("0");
  });

  test("isolates invoice access by authenticated client", async () => {
    const alice = await verifiedClient();
    const account = await ctx.store.getClientByEmail("billing@example.test");
    const today = new Date().toISOString().slice(0, 10);
    const project = await alice.post("/v1/client/projects").send({ name: "Owned project" });
    await operator("post", "/v1/billing/storage-snapshots").send({ date: today });
    const draft = await operator("post", "/v1/billing/invoices/drafts").send({
      clientId: account.client_id, periodStart: today, periodEnd: today,
    });
    expect(draft.status).toBe(201);

    const bob = request.agent(app);
    await bob.post("/v1/client/auth/register").send({
      displayName: "Other Client", email: "other@example.test", password: "correct horse battery",
    });
    const login = await bob.post("/v1/client/auth/login").send({
      email: "other@example.test", password: "correct horse battery",
    });
    expect(login.status).toBe(200);
    expect((await bob.get(`/v1/client/billing/invoices/${draft.body.invoice.invoiceId}`)).status).toBe(404);
    const bobExport = await bob.get("/v1/client/billing/export.csv");
    expect(bobExport.status).toBe(200);
    expect(bobExport.text).not.toContain(draft.body.invoice.invoiceNumber);
    const aliceExport = await alice.get("/v1/client/billing/export.csv");
    expect(aliceExport.text).toContain(draft.body.invoice.invoiceNumber);
    expect(project.body.projectId).not.toBe(account.client_id);
  });
});
