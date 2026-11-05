/*
 * Express router for the public DBaaS API (/v1/...).
 *
 *   Control plane (operator token): /v1/projects..., /v1/audit
 *   Data plane (project API key + scope): /v1/collections, /v1/data,
 *       /v1/query, /v1/import, /v1/usage, /v1/project
 *
 * Every route is declared through route() so it is recorded in the route
 * registry with its access class; tests assert nothing is unclassified.
 *
 * POST /v1/query is shared with the internal query engine: requests
 * carrying `Authorization: Bearer pk_...` are project-scoped; anything
 * else falls through (next("router")) to the OPERATOR-protected legacy
 * handler registered in server.js.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { getConfig } = require("./config");
const { DbaasError, unauthorized, forbidden, badRequest, tooMany, unavailable, conflict, notFound } = require("./errors");
const { RateLimiter } = require("./rate-limit");
const { createOperatorAuth } = require("./security");
const registry = require("./route-registry");
const { logger } = require("./logger");
const { metrics } = require("./metrics");
const {
  OTP_TTL_MS, OTP_RESEND_COOLDOWN_MS, OTP_MAX_ATTEMPTS, generateOtp, hashOtp,
  hashChallengeId, maskEmail, createMailer,
} = require("./client-otp");
const {
  inclusiveDays, aggregateUsageRows, buildUsageLines, renderInvoicePdf, chargePaise, bytesToGb,
} = require("./billing");
const V = require("./validators");
const {
  SESSION_TTL_MS, hashPassword, verifyPassword, createSessionToken, hashSessionToken,
  sessionCookie, readSessionCookie, sameOrigin,
} = require("./client-auth");

const IMPORT_TMP = process.env.MAESTRO_IMPORT_TMP || path.join(os.tmpdir(), "maestro-imports");

function createDbaasRouter({ platform, operatorAuth = createOperatorAuth(), mailer = createMailer() }) {
  const router = express.Router();
  const cp = platform.cp;
  const cfg0 = getConfig();
  const ipLimiter = new RateLimiter({ windowMs: 60000, max: cfg0.ipRateLimitPerMinute });
  const keyLimiter = new RateLimiter({ windowMs: 60000, max: cfg0.rateLimitPerMinute });
  const projectLimiter = new RateLimiter({ windowMs: 60000, max: cfg0.quotas.requestsPerMinute });
  const failLimiter = new RateLimiter({ windowMs: 60000, max: cfg0.authFailLimitPerMinute });
  const clientRegistrationLimiter = new RateLimiter({ windowMs: 60000, max: cfg0.authFailLimitPerMinute });

  function route(method, routePath, { access, scope, variant = "project" }, ...handlers) {
    registry.register({ method: method.toUpperCase(), path: routePath, access, scope: scope || null, variant });
    router[method.toLowerCase()](routePath, ...handlers);
  }

  // ---------- middleware ----------
  const authenticate = async (req, res, next) => {
    try {
      const cfg = getConfig();
      ipLimiter.check(req.ip, cfg.ipRateLimitPerMinute);
      if (failLimiter.blocked(req.ip)) { metrics.inc("maestro_rate_limited_total", { scope: "auth_failures" }); throw tooMany("Too many failed authentication attempts.", 60); }
      let ctx;
      try {
        ctx = await cp.authenticate(req.get("authorization"));
      } catch (e) {
        if (e.status === 401) {
          failLimiter.hit(req.ip);
          metrics.inc("maestro_auth_failures_total", { kind: "api_key" });
          logger.warn("api key authentication failed", { requestId: req.id, ip: req.ip });
        }
        throw e;
      }
      try {
        keyLimiter.check(ctx.apiKeyId, cfg.rateLimitPerMinute);
        projectLimiter.check(ctx.projectId, (ctx.quotas && ctx.quotas.requestsPerMinute) || cfg.quotas.requestsPerMinute);
      } catch (e) { metrics.inc("maestro_rate_limited_total", { scope: "project" }); throw e; }

      // A client may not name a project. If it tries to, it must match its own key.
      const claimed = [req.body && req.body.projectId, req.query && req.query.projectId, req.get("x-project-id")]
        .filter((v) => v !== undefined && v !== null && v !== "");
      if (claimed.some((v) => v !== ctx.projectId)) throw forbidden("projectId does not match the API key.");

      ctx.usage = {};
      ctx.requestId = req.id;
      ctx.ip = req.ip;
      req.maestro = ctx;
      res.on("finish", () => {
        const deltas = { ...ctx.usage, requests: 1, errors: res.statusCode >= 400 ? 1 : 0 };
        cp.recordUsage(ctx.projectId, deltas).catch((e) => logger.error("usage tracking failed", { error: e.message }));
        const requestId = crypto.randomUUID();
        const contentLength = Number(res.getHeader("content-length"));
        const transferAvailable = Number.isSafeInteger(contentLength) && contentLength >= 0;
        const occurredAt = new Date().toISOString();
        const events = [
          { category: "api_requests", quantity: "1", available: true },
          {
            category: "outbound_bytes",
            quantity: transferAvailable ? String(contentLength) : null,
            available: transferAvailable,
          },
        ];
        for (const event of events) {
          cp.store.recordUsageEvent({
            eventId: crypto.randomUUID(),
            requestId,
            projectId: ctx.projectId,
            ...event,
            occurredAt,
          }).catch((e) => logger.error("billable usage event write failed", { requestId, error: e.message }));
        }
      });
      next();
    } catch (e) {
      next(e);
    }
  };

  // Least privilege: the key must carry the scope the route needs.
  const requireScope = (scope) => (req, res, next) => {
    if (!req.maestro.scopes.includes(scope)) {
      return next(new DbaasError(403, "insufficient_scope", `This API key lacks the "${scope}" scope.`, { required: scope }));
    }
    return next();
  };

  const ok = (res, body, status = 200) => res.status(status).json(body);
  const operator = { access: "operator" };
  const client = { access: "client" };
  const audit = (req, action, projectId, target, detail) =>
    cp.audit({ projectId, actor: "operator", action, target, requestId: req.id, ip: req.ip, detail });

  const clientSession = async (req, res, next) => {
    try {
      const token = readSessionCookie(req);
      if (!token) throw unauthorized("Sign in to access the client portal.");
      const session = await cp.store.getClientSession(hashSessionToken(token));
      if (!session) throw unauthorized("Your client session has expired. Please sign in again.");
      const account = await cp.store.getClient(session.client_id);
      if (!account) throw unauthorized("Your client session is no longer valid.");
      req.clientAccount = account;
      req.clientSessionHash = hashSessionToken(token);
      next();
    } catch (e) { next(e); }
  };
  const sameOriginMutation = (req, res, next) => {
    if (!sameOrigin(req)) return next(forbidden("Cross-origin client portal requests are not allowed."));
    next();
  };
  const clientProject = async (req) => cp.getOwnedProject(req.params.projectId, req.clientAccount.client_id);
  const ownedBrowseProject = async (req, res, next) => {
    try {
      req.clientOwnedProject = await clientProject(req);
      next();
    } catch (e) { next(e); }
  };
  const sameBrowseProjectKey = (req, res, next) => {
    if (req.maestro.projectId !== req.clientOwnedProject.project_id) {
      return next(forbidden("The API key does not belong to the selected project."));
    }
    next();
  };
  const publicClient = (account) => ({
    clientId: account.client_id, email: account.email, displayName: account.display_name, createdAt: account.created_at,
  });
  const publicBillingPlan = (plan) => ({
    planId: plan.plan_id,
    name: plan.name,
    currency: plan.currency,
    monthlyFeePaise: String(plan.monthly_fee_paise || 0),
    storagePaisePerGbMonth: String(plan.storage_paise_per_gb_month),
    requestsPerUnit: String(plan.requests_per_unit),
    requestUnitPaise: String(plan.request_unit_paise),
    transferPaisePerGb: String(plan.transfer_paise_per_gb),
    available: Boolean(plan.active),
    pricingConfigured: Boolean(plan.pricing_configured),
  });
  const publicBillingSubscription = (subscription) => subscription ? ({
    subscriptionId: subscription.subscription_id,
    planId: subscription.plan_id,
    status: subscription.status,
    periodStart: String(subscription.period_start).slice(0, 10),
    periodEnd: String(subscription.period_end).slice(0, 10),
    pendingPlanId: subscription.pending_plan_id || null,
    pendingEffectiveAt: subscription.pending_effective_at
      ? String(subscription.pending_effective_at).slice(0, 10)
      : null,
  }) : null;
  const validDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const currentMonth = () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const end = now.toISOString().slice(0, 10);
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return { start, end, periodEnd };
  };
  const publicInvoice = (invoice) => {
    if (!invoice) return null;
    const overdue = ["issued", "partially_paid"].includes(invoice.status) && invoice.due_date &&
      String(invoice.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10) &&
      BigInt(invoice.paid_paise) < BigInt(invoice.amount_due_paise);
    const client = invoice.client_snapshot || {};
    return {
      invoiceId: invoice.invoice_id,
      invoiceNumber: invoice.invoice_number,
      clientId: invoice.client_id,
      periodStart: String(invoice.period_start).slice(0, 10),
      periodEnd: String(invoice.period_end).slice(0, 10),
      dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : null,
      status: overdue ? "overdue" : invoice.status,
      currency: invoice.currency,
      subtotalPaise: String(invoice.subtotal_paise),
      discountPaise: String(invoice.discount_paise),
      creditPaise: String(invoice.credit_paise),
      adjustmentPaise: String(invoice.adjustment_paise),
      taxPaise: String(invoice.tax_paise),
      amountDuePaise: String(invoice.amount_due_paise),
      paidPaise: String(invoice.paid_paise),
      balanceDuePaise: (BigInt(invoice.amount_due_paise) - BigInt(invoice.paid_paise)).toString(),
      demo: Boolean(invoice.demo),
      createdAt: invoice.created_at,
      issuedAt: invoice.issued_at,
      clientName: client.billingName || client.displayName || "Client",
      clientEmail: client.email || "",
      billingAddress: client.billingAddress || null,
      items: (invoice.items || []).map((item) => ({
        description: item.description,
        service: item.service,
        quantity: String(item.quantity),
        unit: item.unit,
        unitPricePaise: String(item.unit_price_paise),
        unitPriceLabel: item.unit_price_label || null,
        amountPaise: String(item.amount_paise),
        usagePeriod: item.usage_period,
      })),
      payments: (invoice.payments || []).map((payment) => ({
        paymentId: payment.payment_id,
        amountPaise: String(payment.amount_paise),
        reference: payment.payment_reference,
        recordedAt: payment.recorded_at,
      })),
    };
  };
  const validateClientInput = (body, { registration = false } = {}) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Request body must be a JSON object.");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Enter a valid email address.");
    if (typeof body.password !== "string" || body.password.length < (registration ? 12 : 1) ||
        body.password.length > 128 || Buffer.byteLength(body.password, "utf8") > 256) {
      throw badRequest(registration ? "Password must be 12-128 characters." : "Invalid email or password.");
    }
    if (!registration) return { email, password: body.password };
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName || displayName.length > 80) throw badRequest("Display name must be 1-80 characters.");
    return { email, password: body.password, displayName };
  };
  const createClientSession = () => {
    const token = createSessionToken();
    return {
      token,
      session: {
        sessionId: `sess_${crypto.randomBytes(12).toString("hex")}`,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      },
    };
  };
  const otpAccountKey = (email) => crypto.createHash("sha256").update(email).digest("hex");
  const checkPersistentClientLimit = async (scope, value, max) => {
    const rateKey = crypto.createHash("sha256").update(`${scope}\0${value}`).digest("hex");
    const result = await cp.store.checkClientAuthRateLimit({ rateKey, max, windowMs: 60000 });
    if (!result.allowed) throw tooMany("Too many client authentication attempts. Retry shortly.", result.retryAfterSeconds);
  };
  const sendOtp = async (email, otp, challengeHash, requestId) => {
    try {
      await mailer.sendOtp(email, otp);
    } catch (error) {
      const knownCodes = new Set([
        "EAUTH", "ECONNECTION", "ECONNREFUSED", "EDNS", "EENVELOPE", "EMESSAGE",
        "ENOTFOUND", "ESOCKET", "ETIMEDOUT", "ETLS",
      ]);
      const smtpCode = knownCodes.has(error && error.code) ? error.code : "UNKNOWN";
      const responseCode = Number.isInteger(error && error.responseCode) &&
        error.responseCode >= 400 && error.responseCode <= 599 ? error.responseCode : null;
      const category = smtpCode === "EAUTH" || responseCode === 534 || responseCode === 535
        ? "authentication_rejected"
        : ["ECONNECTION", "ECONNREFUSED", "EDNS", "ENOTFOUND", "ESOCKET", "ETIMEDOUT", "ETLS"].includes(smtpCode)
          ? "connection_failed"
          : responseCode && responseCode >= 550
            ? "message_rejected"
            : "smtp_error";
      logger.warn("client OTP email delivery failed", {
        requestId,
        category,
        smtpCode,
        responseCode,
      });
      await cp.store.invalidateOtpChallenge(challengeHash);
      throw unavailable("Email verification could not be delivered. Please check your email service configuration or try again later.");
    }
  };

  // ---------- control plane ----------
  route("post", "/v1/projects", operator, operatorAuth, async (req, res) => {
    const body = req.body || {};
    const r = await cp.createProject(body.name, { idempotencyKey: req.get("idempotency-key"), scopes: body.scopes, expiresInDays: body.expiresInDays });
    if (r.replayed) {
      return ok(res, { success: true, ...r.project, replayed: true, note: "This Idempotency-Key was already used. The original API key was shown once and cannot be shown again; create a new key if it was lost." }, 200);
    }
    await audit(req, "project.create", r.project.projectId, r.project.name, { keyId: r.apiKey.keyId });
    return ok(res, {
      success: true, ...r.project, apiKey: r.apiKey.key, apiKeyId: r.apiKey.keyId, scopes: r.apiKey.scopes, expiresAt: r.apiKey.expiresAt,
      note: "Store this API key now — it will not be shown again.",
    }, 201);
  });
  route("get", "/v1/projects", operator, operatorAuth, async (req, res) => ok(res, { success: true, projects: await cp.listProjects() }));
  route("get", "/v1/projects/:projectId", operator, operatorAuth, async (req, res) =>
    ok(res, { success: true, ...(await cp.getProjectDetails(req.params.projectId)), quotas: await cp.getQuotas(req.params.projectId) }));
  route("delete", "/v1/projects/:projectId", operator, operatorAuth, async (req, res) => {
    const purge = req.query.purge === "true";
    const out = await platform.deleteProject(req.params.projectId, { purge });
    await audit(req, "project.delete", req.params.projectId, req.params.projectId, { purge });
    ok(res, out);
  });
  route("post", "/v1/projects/:projectId/keys", operator, operatorAuth, async (req, res) => {
    const b = req.body || {};
    const k = await cp.createApiKey(req.params.projectId, b.label, { scopes: b.scopes, expiresInDays: b.expiresInDays, expiresAt: b.expiresAt });
    await audit(req, "key.create", req.params.projectId, k.keyId, { scopes: k.scopes, expiresAt: k.expiresAt });
    ok(res, { success: true, keyId: k.keyId, apiKey: k.key, prefix: k.prefix, label: k.label, scopes: k.scopes, expiresAt: k.expiresAt, createdAt: k.createdAt,
      note: "Store this API key now — it will not be shown again." }, 201);
  });
  route("delete", "/v1/projects/:projectId/keys/:keyId", operator, operatorAuth, async (req, res) => {
    await cp.revokeApiKey(req.params.projectId, req.params.keyId);
    await audit(req, "key.revoke", req.params.projectId, req.params.keyId);
    ok(res, { success: true, revoked: true });
  });
  route("post", "/v1/projects/:projectId/keys/:keyId/rotate", operator, operatorAuth, async (req, res) => {
    const k = await cp.rotateApiKey(req.params.projectId, req.params.keyId, req.body || {});
    await audit(req, "key.rotate", req.params.projectId, req.params.keyId, { newKeyId: k.keyId, graceSeconds: k.oldKeyValidForSeconds });
    ok(res, { success: true, keyId: k.keyId, apiKey: k.key, prefix: k.prefix, label: k.label, scopes: k.scopes, expiresAt: k.expiresAt, replaced: k.replaced,
      oldKeyValidForSeconds: k.oldKeyValidForSeconds, note: "Store this API key now — it will not be shown again." }, 201);
  });
  route("get", "/v1/projects/:projectId/usage", operator, operatorAuth, async (req, res) => {
    await cp.getProject(req.params.projectId);
    ok(res, await platform.usage({ projectId: req.params.projectId }));
  });
  route("get", "/v1/projects/:projectId/quotas", operator, operatorAuth, async (req, res) =>
    ok(res, { success: true, projectId: req.params.projectId, quotas: await cp.getQuotas(req.params.projectId) }));
  route("put", "/v1/projects/:projectId/quotas", operator, operatorAuth, async (req, res) => {
    const quotas = await cp.setQuotas(req.params.projectId, req.body || {});
    await audit(req, "quotas.update", req.params.projectId, req.params.projectId, req.body);
    ok(res, { success: true, projectId: req.params.projectId, quotas });
  });
  route("get", "/v1/projects/:projectId/imports", operator, operatorAuth, async (req, res) => {
    await cp.getProject(req.params.projectId);
    ok(res, { success: true, imports: await platform.store.listImportJobs(req.params.projectId) });
  });
  route("get", "/v1/audit", operator, operatorAuth, async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const projectId = req.query.projectId || null;
    if (projectId) await cp.getProject(projectId);
    ok(res, { success: true, events: await cp.listAudit({ projectId, limit, beforeId: req.query.before ? Number(req.query.before) : null }) });
  });

  // ---------- billing management (operator) ----------
  route("get", "/v1/billing/clients", operator, operatorAuth, async (req, res) =>
    ok(res, { success: true, clients: await cp.store.listClientBillingProfiles() }));
  route("get", "/v1/billing/plans", operator, operatorAuth, async (req, res) =>
    ok(res, { success: true, plans: await cp.store.listBillingPlans() }));
  route("put", "/v1/billing/plans/:planId", operator, operatorAuth, async (req, res) => {
    const body = req.body || {};
    const values = [
      body.monthlyFeePaise === undefined ? 0 : body.monthlyFeePaise,
      body.storagePaisePerGbMonth, body.requestsPerUnit, body.requestUnitPaise, body.transferPaisePerGb,
    ];
    if (!/^[a-z0-9][a-z0-9-]{1,50}$/.test(req.params.planId) ||
        typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 ||
        values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
        !Number.isSafeInteger(body.requestsPerUnit) || body.requestsPerUnit < 1 ||
        (body.active !== undefined && typeof body.active !== "boolean") ||
        (body.pricingConfigured !== undefined && typeof body.pricingConfigured !== "boolean")) {
      throw badRequest("Provide a plan name, non-negative integer paise rates, positive request unit, and boolean availability/configuration flags.");
    }
    const plan = await cp.store.upsertBillingPlan({
      planId: req.params.planId, name: body.name.trim(),
      monthlyFeePaise: body.monthlyFeePaise === undefined ? 0 : body.monthlyFeePaise,
      storagePaisePerGbMonth: body.storagePaisePerGbMonth,
      requestsPerUnit: body.requestsPerUnit, requestUnitPaise: body.requestUnitPaise,
      transferPaisePerGb: body.transferPaisePerGb, active: body.active !== false,
      pricingConfigured: body.pricingConfigured !== false,
    });
    await cp.audit({ actor: "operator", action: "billing.plan.update", target: plan.plan_id, requestId: req.id, ip: req.ip });
    return ok(res, { success: true, plan });
  });
  route("post", "/v1/billing/storage-snapshots", operator, operatorAuth, async (req, res) => {
    const date = req.body && req.body.date ? req.body.date : new Date().toISOString().slice(0, 10);
    if (!validDate(date) || date > new Date().toISOString().slice(0, 10)) throw badRequest("Snapshot date must be a valid UTC date no later than today.");
    const projects = await cp.listProjects();
    const snapshots = [];
    for (const project of projects) {
      const measured = await platform.usage({ projectId: project.projectId });
      const bytes = measured.usage.storageBytes;
      const available = Number.isSafeInteger(bytes) && bytes >= 0;
      await cp.store.recordStorageSnapshot({
        projectId: project.projectId, date, storageBytes: available ? bytes : null, available,
        reason: available ? null : (measured.warnings || []).join(" ") || "Project storage measurement unavailable.",
      });
      snapshots.push({ projectId: project.projectId, available, storageBytes: available ? bytes : null });
    }
    return ok(res, { success: true, date, snapshots });
  });
  route("post", "/v1/billing/reconcile", operator, operatorAuth, async (req, res) => {
    const body = req.body || {};
    if (!validDate(body.start) || !validDate(body.end) || body.start > body.end || inclusiveDays(body.start, body.end) > 366) {
      throw badRequest("Provide a valid UTC date range of at most 366 days.");
    }
    if (body.projectId) await cp.getProject(body.projectId);
    await cp.store.reconcileDailyUsage({ start: body.start, end: body.end, projectId: body.projectId || null });
    return ok(res, { success: true, start: body.start, end: body.end, timezone: "UTC", idempotent: true });
  });
  route("get", "/v1/billing/usage", operator, operatorAuth, async (req, res) => {
    const clientId = req.query.clientId;
    if (typeof clientId !== "string" || !await cp.store.getClient(clientId)) throw notFound("Client billing profile not found.");
    const range = req.query.start && req.query.end
      ? { start: req.query.start, end: req.query.end }
      : currentMonth();
    if (!validDate(range.start) || !validDate(range.end) || range.start > range.end || inclusiveDays(range.start, range.end) > 366) {
      throw badRequest("Provide a valid UTC date range of at most 366 days.");
    }
    await cp.store.reconcileDailyUsage({ ...range });
    const overview = await cp.store.getBillingOverview(clientId, range.start, range.end);
    const totals = aggregateUsageRows({
      ...overview, periodStart: range.start, periodEnd: range.end,
    });
    return ok(res, {
      success: true, clientId, period: range, timezone: "UTC", plan: overview.plan,
      usage: totals, daily: overview.daily,
    });
  });
  route("get", "/v1/billing/invoices", operator, operatorAuth, async (req, res) =>
    ok(res, { success: true, invoices: (await cp.store.listAllInvoices()).map(publicInvoice) }));
  route("post", "/v1/billing/invoices/drafts", operator, operatorAuth, async (req, res) => {
    const body = req.body || {};
    if (typeof body.clientId !== "string" || !validDate(body.periodStart) || !validDate(body.periodEnd) ||
        body.periodStart > body.periodEnd || inclusiveDays(body.periodStart, body.periodEnd) > 366) {
      throw badRequest("Provide a clientId and valid UTC billing period of at most 366 days.");
    }
    const clientAccount = await cp.store.getClient(body.clientId);
    if (!clientAccount) throw notFound("Client billing profile not found.");
    await cp.store.reconcileDailyUsage({ start: body.periodStart, end: body.periodEnd });
    const overview = await cp.store.getBillingOverview(body.clientId, body.periodStart, body.periodEnd);
    if (!overview.plan) throw unavailable("No active INR billing plan is configured.");
    if (overview.plan.pricing_configured === false) throw conflict("The client's plan does not have configured pricing.");
    const usage = aggregateUsageRows({
      ...overview, periodStart: body.periodStart, periodEnd: body.periodEnd,
    });
    if (!usage.storageAvailable || !usage.transferAvailable) {
      throw conflict("A draft invoice cannot be generated while project storage or outbound transfer measurements are unavailable.");
    }
    const charges = buildUsageLines({
      apiRequests: usage.apiRequests,
      outboundBytes: usage.outboundBytes,
      storageGbMonth: usage.storageGbMonth,
    }, overview.plan, `${body.periodStart} to ${body.periodEnd}`);
    const profile = overview.profile || {};
    const draft = await cp.store.createDraftInvoice({
      invoiceId: `inv_${crypto.randomBytes(12).toString("hex")}`,
      clientId: body.clientId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      subtotalPaise: charges.subtotalPaise,
      items: charges.lines,
      planSnapshot: overview.plan,
      clientSnapshot: {
        displayName: clientAccount.display_name,
        email: clientAccount.email,
        billingName: profile.billing_name || null,
        billingAddress: profile.billing_address || null,
        billingContact: profile.billing_contact || null,
        purchaseOrder: profile.purchase_order || null,
      },
      actor: "operator",
    });
    return ok(res, { success: true, invoice: publicInvoice(draft), replayed: Boolean(draft.replayed) }, draft.replayed ? 200 : 201);
  });
  route("post", "/v1/billing/invoices/:invoiceId/review", operator, operatorAuth, async (req, res) => {
    const reason = typeof (req.body && req.body.reason) === "string" ? req.body.reason.trim() : "";
    if (!reason || reason.length > 500) throw badRequest("A reason of 1-500 characters is required to review an invoice.");
    const invoice = await cp.store.transitionInvoice(req.params.invoiceId, "reviewed", "operator", reason);
    if (!invoice) throw notFound("Invoice not found.");
    return ok(res, { success: true, invoice: publicInvoice(invoice) });
  });
  route("post", "/v1/billing/invoices/:invoiceId/issue", operator, operatorAuth, async (req, res) => {
    const reason = typeof (req.body && req.body.reason) === "string" ? req.body.reason.trim() : "";
    if (!reason || reason.length > 500) throw badRequest("A reason of 1-500 characters is required to issue an invoice.");
    const dueDate = req.body.dueDate || new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
    if (!validDate(dueDate)) throw badRequest("dueDate must be a valid UTC date.");
    const invoice = await cp.store.transitionInvoice(req.params.invoiceId, "issued", "operator", reason, dueDate);
    if (!invoice) throw notFound("Invoice not found.");
    return ok(res, { success: true, invoice: publicInvoice(invoice) });
  });
  route("post", "/v1/billing/invoices/:invoiceId/void", operator, operatorAuth, async (req, res) => {
    const reason = typeof (req.body && req.body.reason) === "string" ? req.body.reason.trim() : "";
    if (!reason || reason.length > 500) throw badRequest("A reason of 1-500 characters is required to void an invoice.");
    const invoice = await cp.store.transitionInvoice(req.params.invoiceId, "void", "operator", reason);
    if (!invoice) throw notFound("Invoice not found.");
    return ok(res, { success: true, invoice: publicInvoice(invoice) });
  });
  route("post", "/v1/billing/payments", operator, operatorAuth, async (req, res) => {
    const body = req.body || {};
    if (typeof body.invoiceId !== "string" || typeof body.amountPaise !== "string" ||
        !/^[1-9]\d{0,14}$/.test(body.amountPaise) || typeof body.reference !== "string" ||
        !body.reference.trim() || body.reference.length > 120) {
      throw badRequest("Provide an invoiceId, positive integer amountPaise, and payment reference.");
    }
    const invoice = await cp.store.recordInvoicePayment({
      invoiceId: body.invoiceId, paymentId: `pay_${crypto.randomBytes(12).toString("hex")}`,
      amountPaise: body.amountPaise, reference: body.reference.trim(), actor: "operator",
    });
    if (!invoice) throw notFound("Invoice not found.");
    return ok(res, { success: true, invoice: publicInvoice(invoice) }, 201);
  });
  route("get", "/v1/billing/audit", operator, operatorAuth, async (req, res) =>
    ok(res, { success: true, events: await cp.store.listBillingAudit(Math.min(500, Math.max(1, Number(req.query.limit) || 200))) }));
  route("get", "/v1/billing/export.csv", operator, operatorAuth, async (req, res) => {
    const kind = req.query.kind || "usage";
    const csv = (value) => `"${String(value === null || value === undefined ? "" : value).replace(/"/g, '""')}"`;
    const lines = [];
    if (kind === "invoices") {
      lines.push(["invoice_number", "client_id", "period_start", "period_end", "status", "description", "quantity", "unit", "unit_price_paise", "amount_paise"]
        .map(csv).join(","));
      for (const invoice of await cp.store.listAllInvoices()) {
        for (const item of invoice.items || []) {
          lines.push([
            invoice.invoice_number, invoice.client_id, String(invoice.period_start).slice(0, 10),
            String(invoice.period_end).slice(0, 10), invoice.status, item.description, item.quantity,
            item.unit, item.unit_price_paise, item.amount_paise,
          ].map(csv).join(","));
        }
      }
    } else if (kind === "usage") {
      const start = req.query.start;
      const end = req.query.end;
      if (!validDate(start) || !validDate(end) || start > end || inclusiveDays(start, end) > 31) {
        throw badRequest("Usage CSV export requires a valid UTC date range of at most 31 days.");
      }
      await cp.store.reconcileDailyUsage({ start, end });
      lines.push(["client_id", "project_id", "date_utc", "api_requests", "outbound_bytes", "transfer_available", "storage_bytes", "storage_available", "measurement_note"]
        .map(csv).join(","));
      for (const clientProfile of await cp.store.listClientBillingProfiles()) {
        const overview = await cp.store.getBillingOverview(clientProfile.client_id, start, end);
        for (const row of overview.daily) {
          lines.push([
            clientProfile.client_id, row.project_id, String(row.usage_date).slice(0, 10),
            row.api_requests, row.outbound_bytes, row.transfer_available,
            row.storage_bytes, row.storage_available, row.storage_reason,
          ].map(csv).join(","));
        }
      }
    } else {
      throw badRequest("kind must be usage or invoices.");
    }
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="maestro-billing-${kind}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.status(200).send(lines.join("\r\n"));
  });

  // ---------- client portal ----------
  route("post", "/v1/client/auth/register", { access: "public" }, sameOriginMutation, async (req, res) => {
    clientRegistrationLimiter.check(req.ip);
    const input = validateClientInput(req.body, { registration: true });
    const account = await cp.store.createClient({
      clientId: `client_${crypto.randomBytes(12).toString("hex")}`,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName,
    });
    return ok(res, {
      success: true,
      account: publicClient(account),
      message: "Account created. Sign in to access the Client Portal.",
    }, 201);
  });
  route("post", "/v1/client/auth/login", { access: "public" }, sameOriginMutation, async (req, res) => {
    const config = getConfig();
    await checkPersistentClientLimit("ip", req.ip, config.authFailLimitPerMinute);
    const input = validateClientInput(req.body);
    await checkPersistentClientLimit("account", otpAccountKey(input.email), config.otpAccountRateLimitPerMinute);
    const account = await cp.store.getClientByEmail(input.email);
    const valid = await verifyPassword(input.password, account ? account.password_hash : undefined);
    if (!account || !valid) throw unauthorized("Invalid email or password.");
    const { token, session } = createClientSession();
    await cp.store.createClientSession({ ...session, clientId: account.client_id });
    res.set("Set-Cookie", sessionCookie(token, req));
    return ok(res, { success: true, account: publicClient(account) });
  });
  route("post", "/v1/client/auth/verify-otp", { access: "public" }, sameOriginMutation, async (req, res) => {
    const config = getConfig();
    await checkPersistentClientLimit("ip", req.ip, config.authFailLimitPerMinute);
    const body = req.body || {};
    if (typeof body.challengeId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.challengeId) ||
        typeof body.otp !== "string" || !/^\d{6}$/.test(body.otp)) {
      throw unauthorized("The verification code is invalid or expired.");
    }
    const challengeHash = hashChallengeId(body.challengeId);
    const accountPreview = await cp.store.getOtpChallengeAccount(challengeHash);
    if (!accountPreview) throw unauthorized("The verification code is invalid or expired.");
    await checkPersistentClientLimit("verify", otpAccountKey(accountPreview.email), config.authFailLimitPerMinute);
    const { token, session } = createClientSession();
    const result = await cp.store.verifyOtpChallenge({
      challengeHash,
      otpHash: hashOtp(body.otp, challengeHash, accountPreview.client_id),
      now: Date.now(),
      maxAttempts: OTP_MAX_ATTEMPTS,
      session,
    });
    if (result.status === "incorrect") throw unauthorized("The verification code is incorrect.");
    if (result.status === "locked") throw tooMany("Too many incorrect verification codes. Sign in to start again.", 60);
    if (result.status !== "verified") throw unauthorized("The verification code is invalid or expired.");
    res.set("Set-Cookie", sessionCookie(token, req));
    return ok(res, { success: true, account: publicClient(result.account) });
  });
  route("post", "/v1/client/auth/resend-otp", { access: "public" }, sameOriginMutation, async (req, res) => {
    const config = getConfig();
    await checkPersistentClientLimit("ip", req.ip, config.authFailLimitPerMinute);
    const id = req.body && req.body.challengeId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
      throw unauthorized("The verification challenge is invalid or expired.");
    }
    const challengeHash = hashChallengeId(id);
    const current = await cp.store.getOtpChallengeAccount(challengeHash);
    if (!current) throw unauthorized("The verification challenge is invalid or expired.");
    await checkPersistentClientLimit("account", otpAccountKey(current.email), config.otpAccountRateLimitPerMinute);
    const now = Date.now();
    const otp = generateOtp();
    const updated = await cp.store.resendOtpChallenge({
      challengeHash,
      otpHash: hashOtp(otp, challengeHash, current.client_id),
      now,
      expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
      resendAfter: new Date(now + OTP_RESEND_COOLDOWN_MS).toISOString(),
    });
    if (updated.status === "cooldown") {
      const retryAfter = Math.max(1, Math.ceil((Date.parse(updated.resendAfter) - now) / 1000));
      throw tooMany("Please wait before requesting another code.", retryAfter);
    }
    if (updated.status !== "sent") throw unauthorized("The verification challenge is invalid or expired.");
    await sendOtp(current.email, otp, challengeHash, req.id);
    return ok(res, {
      success: true, maskedEmail: maskEmail(current.email),
      expiresAt: new Date(now + OTP_TTL_MS).toISOString(),
      resendAvailableAt: new Date(now + OTP_RESEND_COOLDOWN_MS).toISOString(),
    });
  });
  route("post", "/v1/client/auth/logout", client, clientSession, sameOriginMutation, async (req, res) => {
    await cp.store.deleteClientSession(req.clientSessionHash);
    res.set("Set-Cookie", sessionCookie("", req, 0));
    return ok(res, { success: true, signedOut: true });
  });
  route("get", "/v1/client/auth/me", client, clientSession, async (req, res) =>
    ok(res, { success: true, account: publicClient(req.clientAccount) }));
  route("get", "/v1/client/billing/plans", client, clientSession, async (req, res) =>
    ok(res, {
      success: true,
      plans: (await cp.store.listBillingPlans())
        .filter((plan) => plan.active)
        .map(publicBillingPlan),
    }));
  route("put", "/v1/client/billing/subscription", client, clientSession, sameOriginMutation, async (req, res) => {
    const planId = req.body && req.body.planId;
    if (typeof planId !== "string" || !/^[a-z0-9][a-z0-9-]{1,50}$/.test(planId)) {
      throw badRequest("Provide a valid planId.");
    }
    const plan = (await cp.store.listBillingPlans()).find((item) => item.plan_id === planId);
    if (!plan || !plan.active || !plan.pricing_configured) {
      throw conflict("That plan is unavailable until an operator configures its pricing.");
    }
    await cp.store.setClientSubscription({
      clientId: req.clientAccount.client_id, planId,
    });
    const currentSubscription = await cp.store.getClientSubscription(req.clientAccount.client_id);
    await cp.audit({
      actor: `client:${req.clientAccount.client_id}`, action: "billing.subscription.change",
      target: planId, requestId: req.id, ip: req.ip,
    });
    return ok(res, {
      success: true,
      subscription: publicBillingSubscription(currentSubscription.subscription),
      pendingPlan: currentSubscription.pendingPlan ? publicBillingPlan(currentSubscription.pendingPlan) : null,
      message: currentSubscription.subscription.pending_plan_id
        ? `Plan change scheduled for ${currentSubscription.subscription.pending_effective_at}. No payment was processed.`
        : "Your current plan remains active. No payment was processed.",
    });
  });
  route("get", "/v1/client/billing/usage", client, clientSession, async (req, res) => {
    const current = currentMonth();
    await cp.store.reconcileDailyUsage({ start: current.start, end: current.end });
    const overview = await cp.store.getBillingOverview(req.clientAccount.client_id, current.start, current.end);
    const usage = aggregateUsageRows({
      ...overview, periodStart: current.start, periodEnd: current.end,
    });
    let estimatedCharges = null;
    if (overview.plan && overview.plan.pricing_configured !== false) {
      const plan = overview.plan;
      const apiPaise = chargePaise(usage.apiRequests, plan.request_unit_paise, plan.requests_per_unit);
      const storagePaise = usage.storageAvailable
        ? chargePaise(usage.storageGbMonth, plan.storage_paise_per_gb_month)
        : null;
      const transferPaise = usage.transferAvailable
        ? chargePaise(bytesToGb(usage.outboundBytes), plan.transfer_paise_per_gb)
        : null;
      const monthlyFeePaise = BigInt(plan.monthly_fee_paise || 0);
      const total = storagePaise === null || transferPaise === null
        ? null
        : monthlyFeePaise + storagePaise + apiPaise + transferPaise;
      estimatedCharges = {
        currency: "INR",
        monthlyFeePaise: monthlyFeePaise.toString(),
        storagePaise: storagePaise === null ? null : storagePaise.toString(),
        apiPaise: apiPaise.toString(),
        transferPaise: transferPaise === null ? null : transferPaise.toString(),
        totalPaise: total === null ? null : total.toString(),
        complete: usage.storageAvailable && usage.transferAvailable,
      };
    }
    return ok(res, {
      success: true,
      timezone: "UTC",
      period: { start: current.start, through: current.end, end: current.periodEnd },
      plan: overview.plan ? publicBillingPlan(overview.plan) : null,
      subscription: publicBillingSubscription(overview.subscription),
      pendingPlan: overview.pendingPlan ? publicBillingPlan(overview.pendingPlan) : null,
      projects: overview.projects,
      usage,
      estimatedCharges,
      estimate: true,
    });
  });
  route("get", "/v1/client/billing/invoices", client, clientSession, async (req, res) =>
    ok(res, {
      success: true,
      invoices: (await cp.store.listInvoicesForClient(req.clientAccount.client_id)).map(publicInvoice),
    }));
  route("get", "/v1/client/billing/invoices/:invoiceId", client, clientSession, async (req, res) => {
    const invoice = await cp.store.getInvoice(req.params.invoiceId);
    if (!invoice || invoice.client_id !== req.clientAccount.client_id) throw notFound("Invoice not found.");
    return ok(res, { success: true, invoice: publicInvoice(invoice) });
  });
  route("get", "/v1/client/billing/invoices/:invoiceId/pdf", client, clientSession, async (req, res) => {
    const invoice = await cp.store.getInvoice(req.params.invoiceId);
    if (!invoice || invoice.client_id !== req.clientAccount.client_id) throw notFound("Invoice not found.");
    if (!invoice.issued_snapshot) throw conflict("Invoice PDF is available after issuance.");
    const pdf = await renderInvoicePdf(invoice.issued_snapshot);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${String(invoice.invoice_number).replace(/[^A-Za-z0-9-]/g, "")}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    });
    return res.status(200).send(pdf);
  });
  route("get", "/v1/client/billing/payments", client, clientSession, async (req, res) =>
    ok(res, {
      success: true,
      payments: (await cp.store.listInvoicePaymentsForClient(req.clientAccount.client_id)).map((payment) => ({
        invoiceNumber: payment.invoice_number,
        amountPaise: String(payment.amount_paise),
        reference: payment.payment_reference,
        recordedAt: payment.recorded_at,
      })),
    }));
  route("get", "/v1/client/billing/export.csv", client, clientSession, async (req, res) => {
    const clientId = req.clientAccount.client_id;
    const current = currentMonth();
    const ownedProjects = await cp.listOwnedProjects(clientId);
    for (const project of ownedProjects) {
      await cp.store.reconcileDailyUsage({
        start: current.start, end: current.end, projectId: project.projectId,
      });
    }
    const overview = await cp.store.getBillingOverview(clientId, current.start, current.end);
    const usage = aggregateUsageRows({
      ...overview, periodStart: current.start, periodEnd: current.end,
    });
    const csvCell = (value) => {
      let text = String(value === null || value === undefined ? "" : value);
      if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const lines = [[
      "record_type", "period_start_utc", "period_end_utc", "item", "status",
      "quantity", "unit", "amount_paise", "notes",
    ].map(csvCell).join(",")];
    if (overview.plan) {
      lines.push([
        "plan", current.start, current.periodEnd, overview.plan.name,
        overview.subscription ? overview.subscription.status : "active",
        overview.plan.monthly_fee_paise || 0, "INR/month", "",
        overview.subscription && overview.subscription.pending_plan_id
          ? `Plan change to ${overview.subscription.pending_plan_id} effective ${overview.subscription.pending_effective_at}`
          : "",
      ].map(csvCell).join(","));
    }
    const estimateParts = [];
    if (overview.plan && overview.plan.pricing_configured !== false) {
      estimateParts.push([
        "plan fee", "1", "month", String(overview.plan.monthly_fee_paise || 0),
      ]);
      estimateParts.push([
        "API requests", usage.apiRequests, "requests",
        chargePaise(usage.apiRequests, overview.plan.request_unit_paise, overview.plan.requests_per_unit).toString(),
      ]);
      estimateParts.push([
        "storage", usage.storageGbMonth === null ? "" : usage.storageGbMonth, "GB-month",
        usage.storageAvailable
          ? chargePaise(usage.storageGbMonth, overview.plan.storage_paise_per_gb_month).toString()
          : "",
      ]);
      estimateParts.push([
        "outbound transfer", usage.outboundBytes === null ? "" : bytesToGb(usage.outboundBytes), "GB",
        usage.transferAvailable
          ? chargePaise(bytesToGb(usage.outboundBytes), overview.plan.transfer_paise_per_gb).toString()
          : "",
      ]);
    }
    for (const [name, quantity, unit, amount] of estimateParts) {
      lines.push([
        "estimate", current.start, current.end, name, "estimated",
        quantity, unit, amount, "Estimate only; not an invoice or completed charge.",
      ].map(csvCell).join(","));
    }
    const invoices = await cp.store.listInvoicesForClient(clientId);
    for (const invoice of invoices) {
      lines.push([
        "invoice", String(invoice.period_start).slice(0, 10), String(invoice.period_end).slice(0, 10),
        invoice.invoice_number, invoice.status, "", "", String(invoice.amount_due_paise),
        `Paid ${invoice.paid_paise}; balance ${BigInt(invoice.amount_due_paise) - BigInt(invoice.paid_paise)} paise`,
      ].map(csvCell).join(","));
      for (const item of invoice.items || []) {
        lines.push([
          "invoice_item", String(invoice.period_start).slice(0, 10), String(invoice.period_end).slice(0, 10),
          item.description, invoice.status, String(item.quantity), item.unit, String(item.amount_paise),
          item.service,
        ].map(csvCell).join(","));
      }
    }
    const payments = await cp.store.listInvoicePaymentsForClient(clientId);
    for (const payment of payments) {
      lines.push([
        "payment_record", "", "", payment.invoice_number, "recorded",
        "", "", String(payment.amount_paise), payment.payment_reference,
      ].map(csvCell).join(","));
    }
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="maestro-my-billing.csv"',
      "Cache-Control": "no-store",
    });
    return res.status(200).send(lines.join("\r\n"));
  });
  route("put", "/v1/client/billing/profile", client, clientSession, sameOriginMutation, async (req, res) => {
    const body = req.body || {};
    const fields = {
      billingName: "billingName", billingAddress: "billingAddress",
      billingContact: "billingContact", purchaseOrder: "purchaseOrder",
    };
    for (const name of Object.values(fields)) {
      if (body[name] !== undefined && (typeof body[name] !== "string" || body[name].length > (name === "billingAddress" ? 1000 : 200))) {
        throw badRequest(`${name} must be a string within the allowed length.`);
      }
    }
    const profile = await cp.store.saveBillingProfile(req.clientAccount.client_id, {
      billingName: body.billingName && body.billingName.trim() || null,
      billingAddress: body.billingAddress && body.billingAddress.trim() || null,
      billingContact: body.billingContact && body.billingContact.trim() || null,
      purchaseOrder: body.purchaseOrder && body.purchaseOrder.trim() || null,
    });
    return ok(res, { success: true, profile });
  });
  route("get", "/v1/client/projects", client, clientSession, async (req, res) =>
    ok(res, { success: true, projects: await cp.listOwnedProjects(req.clientAccount.client_id) }));
  route("post", "/v1/client/projects", client, clientSession, sameOriginMutation, async (req, res) => {
    const body = req.body || {};
    const scopes = body.scopes === undefined
      ? ["data:read", "data:write", "collections:manage", "usage:read"]
      : body.scopes;
    const result = await cp.createProject(body.name, {
      idempotencyKey: req.get("idempotency-key"),
      scopes,
      ownerClientId: req.clientAccount.client_id,
    });
    if (result.replayed) {
      return ok(res, {
        success: true, ...result.project, replayed: true,
        note: "This request was already completed. Its API key was shown once and cannot be recovered; create another key if it was lost.",
      });
    }
    await cp.audit({
      projectId: result.project.projectId, actor: `client:${req.clientAccount.client_id}`,
      action: "project.create", target: result.project.name, requestId: req.id, ip: req.ip,
      detail: { keyId: result.apiKey.keyId },
    });
    return ok(res, {
      success: true, ...result.project,
      apiKey: result.apiKey.key, apiKeyId: result.apiKey.keyId,
      scopes: result.apiKey.scopes, expiresAt: result.apiKey.expiresAt,
      note: "Store this API key now — it will not be shown again.",
    }, 201);
  });
  route("get", "/v1/client/projects/:projectId", client, clientSession, async (req, res) => {
    const detail = await cp.getOwnedProjectDetails(req.params.projectId, req.clientAccount.client_id);
    return ok(res, {
      success: true, ...detail,
      quotas: await cp.getQuotas(req.params.projectId),
    });
  });
  route("get", "/v1/client/projects/:projectId/keys", client, clientSession, async (req, res) => {
    await clientProject(req);
    return ok(res, { success: true, keys: await cp.listApiKeys(req.params.projectId) });
  });
  route("post", "/v1/client/projects/:projectId/keys", client, clientSession, sameOriginMutation, async (req, res) => {
    await clientProject(req);
    const body = req.body || {};
    const scopes = body.scopes === undefined ? ["data:read"] : body.scopes;
    const key = await cp.createApiKey(req.params.projectId, body.label, { scopes, expiresInDays: body.expiresInDays });
    await cp.audit({
      projectId: req.params.projectId, actor: `client:${req.clientAccount.client_id}`,
      action: "key.create", target: key.keyId, requestId: req.id, ip: req.ip,
      detail: { scopes: key.scopes, expiresAt: key.expiresAt },
    });
    return ok(res, {
      success: true, keyId: key.keyId, apiKey: key.key, prefix: key.prefix,
      label: key.label, scopes: key.scopes, expiresAt: key.expiresAt, createdAt: key.createdAt,
      note: "Store this API key now — it will not be shown again.",
    }, 201);
  });
  route("delete", "/v1/client/projects/:projectId/keys/:keyId", client, clientSession, sameOriginMutation, async (req, res) => {
    await clientProject(req);
    await cp.revokeApiKey(req.params.projectId, req.params.keyId);
    await cp.audit({
      projectId: req.params.projectId, actor: `client:${req.clientAccount.client_id}`,
      action: "key.revoke", target: req.params.keyId, requestId: req.id, ip: req.ip,
    });
    return ok(res, { success: true, revoked: true });
  });
  route("get", "/v1/client/projects/:projectId/usage", client, clientSession, async (req, res) => {
    const project = await clientProject(req);
    return ok(res, await platform.usage({
      projectId: project.project_id,
      quotas: await cp.getQuotas(req.params.projectId),
    }));
  });
  route(
    "get", "/v1/client/projects/:projectId/browse/:collection",
    { ...client, scope: "data:read" },
    clientSession, ownedBrowseProject, authenticate, sameBrowseProjectKey, requireScope("data:read"),
    async (req, res) => {
      const maxPageSize = Math.min(50, getConfig().maxQueryLimit);
      const limit = V.parseIntParam(req.query.limit, "limit", {
        min: 1, max: maxPageSize, fallback: maxPageSize,
      });
      const offset = V.parseIntParam(req.query.offset, "offset", {
        min: 0, max: 1000000, fallback: 0,
      });
      const result = await platform.list(req.maestro, req.params.collection, { limit, offset });
      return ok(res, result);
    },
  );

  // ---------- data plane ----------
  const key = (scope) => ({ access: "key", scope });
  route("get", "/v1/project", key(null), authenticate, async (req, res) => {
    const p = await cp.getProject(req.maestro.projectId);
    ok(res, { success: true, ...cp.publicProject(p), scopes: req.maestro.scopes });
  });

  route("post", "/v1/collections", key("collections:manage"), authenticate, requireScope("collections:manage"), async (req, res) => ok(res, await platform.createCollection(req.maestro, req.body || {}), 201));
  route("get", "/v1/collections", key("data:read"), authenticate, requireScope("data:read"), async (req, res) => ok(res, await platform.listCollections(req.maestro)));
  route("get", "/v1/collections/:name", key("data:read"), authenticate, requireScope("data:read"), async (req, res) => ok(res, await platform.getCollection(req.maestro, req.params.name)));
  route("delete", "/v1/collections/:name", key("collections:manage"), authenticate, requireScope("collections:manage"), async (req, res) => ok(res, await platform.deleteCollection(req.maestro, req.params.name)));

  route("post", "/v1/data", key("data:write"), authenticate, requireScope("data:write"), async (req, res) => ok(res, await platform.insert(req.maestro, req.body || {}), 201));
  route("get", "/v1/data/:collection", key("data:read"), authenticate, requireScope("data:read"), async (req, res) => ok(res, await platform.list(req.maestro, req.params.collection, req.query)));
  route("get", "/v1/data/:collection/:id", key("data:read"), authenticate, requireScope("data:read"), async (req, res) => ok(res, await platform.getById(req.maestro, req.params.collection, req.params.id)));
  route("put", "/v1/data/:collection/:id", key("data:write"), authenticate, requireScope("data:write"), async (req, res) => ok(res, await platform.update(req.maestro, req.params.collection, req.params.id, req.body || {})));
  route("patch", "/v1/data/:collection/:id", key("data:write"), authenticate, requireScope("data:write"), async (req, res) => ok(res, await platform.update(req.maestro, req.params.collection, req.params.id, req.body || {}, { merge: true })));
  route("delete", "/v1/data/:collection/:id", key("data:write"), authenticate, requireScope("data:write"), async (req, res) => ok(res, await platform.remove(req.maestro, req.params.collection, req.params.id)));

  route(
    "post", "/v1/query", key("data:read"),
    (req, res, next) => (/^Bearer\s+pk_/i.test(req.get("authorization") || "") ? next() : next("router")),
    authenticate, requireScope("data:read"),
    async (req, res) => ok(res, await platform.query(req.maestro, req.body || {})),
  );

  // ---------- bulk import (multipart) ----------
  fs.mkdirSync(IMPORT_TMP, { recursive: true });
  const upload = multer({
    dest: IMPORT_TMP,
    limits: { fileSize: cfg0.maxImportBytes, files: 1, fields: 10, parts: 12 },
    fileFilter: (req, file, cb) => {
      if (/\.(csv|tsv|json|ndjson|jsonl)$/i.test(file.originalname || "")) return cb(null, true);
      return cb(new DbaasError(415, "unsupported_media_type", "Only .csv, .tsv, .json and .ndjson files are accepted."));
    },
  });
  route("post", "/v1/import", key("import"), authenticate, requireScope("import"), requireScope("data:write"), upload.single("file"), async (req, res) => {
    try {
      if (!req.file) throw badRequest('Upload a file in the multipart field "file".');
      const b = req.body || {};
      // Multipart fields are parsed after authentication, so repeat the
      // project-spoofing check here.
      if (b.projectId !== undefined && b.projectId !== req.maestro.projectId) throw forbidden("projectId does not match the API key.");
      const report = await platform.importFile(req.maestro, {
        collection: b.collection, filePath: req.file.path, filename: req.file.originalname,
        dryRun: b.dryRun === "true" || b.dryRun === true, idField: b.idField, onDuplicate: b.onDuplicate || "error", storageHint: b.storageHint,
      });
      const status = report.dryRun ? 200 : report.status === "success" ? 201 : report.status === "partial" ? 207 : 422;
      ok(res, report, status);
    } finally {
      if (req.file) fs.unlink(req.file.path, () => {});
    }
  });
  route("get", "/v1/imports", key("import"), authenticate, requireScope("import"), async (req, res) =>
    ok(res, { success: true, imports: await platform.store.listImportJobs(req.maestro.projectId) }));

  route("get", "/v1/usage", key("usage:read"), authenticate, requireScope("usage:read"), async (req, res) => ok(res, await platform.usage(req.maestro)));

  return router;
}

// Mounted at "/v1" AFTER the router so it also catches body-parser and upload errors.
function dbaasErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const reply = (status, code, message, extra = {}) =>
    res.status(status).json({ success: false, message, error: { code, message, requestId: req.id, ...extra } });
  if (err instanceof DbaasError) {
    if (err.retryAfterSeconds) res.set("Retry-After", String(err.retryAfterSeconds));
    return reply(err.status, err.code, err.message, err.details ? { details: err.details } : {});
  }
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return reply(413, "payload_too_large", `File is too large (max ${getConfig().maxImportBytes} bytes).`);
    return reply(400, "invalid_request", "Invalid multipart upload.");
  }
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError) && err.status === 400) return reply(400, "invalid_request", "Request body is not valid JSON.");
  if (err && err.type === "entity.too.large") return reply(413, "payload_too_large", "Request body is too large.");
  logger.error("unexpected error", { requestId: req.id, error: err && err.message, stack: err && err.stack && err.stack.split("\n").slice(0, 4).join(" | ") });
  return reply(500, "internal_error", "Internal server error.");
}

module.exports = { createDbaasRouter, dbaasErrorHandler };
