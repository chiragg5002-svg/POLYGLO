/*
 * In-memory control-plane store. Used by unit tests (and available for
 * throw-away local demos). Implements the same async interface as the
 * PostgreSQL store so the service layer can't tell them apart.
 */
const { conflict } = require("../errors");
const crypto = require("crypto");

const USAGE_FIELDS = ["requests", "queries", "inserts", "updates", "deletes", "errors"];
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class MemoryControlStore {
  constructor() {
    this.projects = new Map();
    this.keys = new Map();
    this.collections = new Map(); // `${projectId}\0${name}`
    this.mappings = new Map();
    this.usage = new Map();
    this.audit = [];
    this.imports = [];
    this.idem = new Map();
    this.clients = new Map();
    this.clientSessions = new Map();
    this.otpChallenges = new Map();
    this.clientAuthRateLimits = new Map();
    this.billingPlans = new Map([["demo-inr-v1", {
      plan_id: "demo-inr-v1", name: "Demonstration INR plan", currency: "INR",
      monthly_fee_paise: "0", pricing_configured: true,
      storage_paise_per_gb_month: "2000", requests_per_unit: "100000",
      request_unit_paise: "500", transfer_paise_per_gb: "1000", active: true,
    }], ["free", {
      plan_id: "free", name: "Free", currency: "INR", monthly_fee_paise: "0",
      storage_paise_per_gb_month: "0", requests_per_unit: "100000",
      request_unit_paise: "0", transfer_paise_per_gb: "0", active: true,
      pricing_configured: true,
    }], ["pro", {
      plan_id: "pro", name: "Pro", currency: "INR", monthly_fee_paise: "0",
      storage_paise_per_gb_month: "0", requests_per_unit: "100000",
      request_unit_paise: "0", transfer_paise_per_gb: "0", active: true,
      pricing_configured: false,
    }], ["enterprise", {
      plan_id: "enterprise", name: "Enterprise", currency: "INR", monthly_fee_paise: "0",
      storage_paise_per_gb_month: "0", requests_per_unit: "100000",
      request_unit_paise: "0", transfer_paise_per_gb: "0", active: true,
      pricing_configured: false,
    }]]);
    this.clientBillingSubscriptions = new Map();
    this.usageEvents = new Map();
    this.dailyUsage = new Map();
    this.storageSnapshots = new Map();
    this.billingProfiles = new Map();
    this.invoices = new Map();
    this.invoiceItems = new Map();
    this.invoicePayments = new Map();
    this.billingAudit = [];
    this._invoiceSeq = 0;
    this._auditSeq = 0;
  }

  async init() {}
  async close() {}

  async createProject({ projectId, name }) {
    return (await this.createProjectWithKey({ projectId, name })).project;
  }
  async createProjectWithKey({ projectId, name, idempotencyHash = null, key = null, ownerClientId = null }) {
    if (idempotencyHash && this.idem.has(idempotencyHash)) {
      return { project: clone(this.projects.get(this.idem.get(idempotencyHash))), replayed: true };
    }
    const row = { project_id: projectId, name, status: "active", created_at: new Date().toISOString(), quotas: null, owner_client_id: ownerClientId };
    this.projects.set(projectId, row);
    if (idempotencyHash) this.idem.set(idempotencyHash, projectId);
    this.usage.set(projectId, this._emptyUsage(projectId));
    const keyRow = key ? await this.createApiKey({ ...key, projectId }) : null;
    return { project: clone(row), key: keyRow, replayed: false };
  }
  async getProject(projectId) { return clone(this.projects.get(projectId) || null); }
  async listProjectsForClient(clientId) {
    return [...this.projects.values()].filter((p) => p.status !== "deleted" && p.owner_client_id === clientId).map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async listProjects() {
    return [...this.projects.values()].filter((p) => p.status !== "deleted").map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async setProjectStatus(projectId, status) {
    const p = this.projects.get(projectId);
    if (!p) return null;
    p.status = status;
    return clone(p);
  }

  async createApiKey({ keyId, projectId, hash, prefix, label, scopes, expiresAt = null, rotatedFrom = null }) {
    const row = { key_id: keyId, project_id: projectId, key_hash: hash, key_prefix: prefix, label: label || null,
      status: "active", scopes: scopes || [], expires_at: expiresAt, rotated_from: rotatedFrom,
      created_at: new Date().toISOString(), last_used_at: null };
    this.keys.set(keyId, row);
    return clone(row);
  }
  async getApiKey(keyId) { return clone(this.keys.get(keyId) || null); }
  async listApiKeys(projectId) {
    return [...this.keys.values()].filter((k) => k.project_id === projectId).map((k) => { const c = clone(k); delete c.key_hash; return c; });
  }
  async revokeApiKey(projectId, keyId) {
    const k = this.keys.get(keyId);
    if (!k || k.project_id !== projectId) return false;
    k.status = "revoked";
    return true;
  }
  async setApiKeyExpiry(projectId, keyId, expiresAt) {
    const k = this.keys.get(keyId);
    if (!k || k.project_id !== projectId || k.status !== "active") return false;
    k.expires_at = expiresAt;
    return true;
  }
  async revokeAllApiKeys(projectId) {
    for (const k of this.keys.values()) if (k.project_id === projectId) k.status = "revoked";
  }
  async touchApiKey(keyId) {
    const k = this.keys.get(keyId);
    if (k) k.last_used_at = new Date().toISOString();
  }
  async setQuotas(projectId, quotas) {
    const p = this.projects.get(projectId);
    if (!p) return null;
    p.quotas = clone(quotas);
    return clone(p);
  }
  async addAuditEvent({ projectId = null, actor, action, target = null, requestId = null, ip = null, detail = null }) {
    this._auditSeq += 1;
    this.audit.push({ id: this._auditSeq, at: new Date().toISOString(), project_id: projectId, actor, action, target, request_id: requestId, ip, detail: clone(detail) });
  }
  async listAuditEvents({ projectId = null, limit = 100, beforeId = null } = {}) {
    return this.audit.filter((e) => (!projectId || e.project_id === projectId) && (!beforeId || e.id < beforeId)).slice().reverse().slice(0, limit).map(clone);
  }
  async recordImportJob(job) { this.imports.push({ import_id: job.importId, project_id: job.projectId, collection: job.collection, status: job.status, dry_run: Boolean(job.dryRun), total: job.total, inserted: job.inserted, skipped: job.skipped, failed: job.failed, created_at: new Date().toISOString() }); }
  async listImportJobs(projectId, limit = 50) { return this.imports.filter((j) => j.project_id === projectId).slice().reverse().slice(0, limit).map(clone); }
  async ping() { return true; }
  async getSchemaVersion() { return 7; }

  async createClient({ clientId, email, passwordHash, displayName }) {
    if ([...this.clients.values()].some((c) => c.email === email)) {
      throw conflict("An account with this email already exists.");
    }
    const row = { client_id: clientId, email, password_hash: passwordHash, display_name: displayName, created_at: new Date().toISOString() };
    this.clients.set(clientId, row);
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    this.clientBillingSubscriptions.set(clientId, {
      subscription_id: `sub_${crypto.randomBytes(12).toString("hex")}`,
      client_id: clientId, plan_id: "free", status: "active",
      period_start: periodStart, period_end: periodEnd,
      created_at: now.toISOString(), updated_at: now.toISOString(),
    });
    return clone(row);
  }
  async getClientByEmail(email) {
    const client = [...this.clients.values()].find((c) => c.email === email);
    return clone(client || null);
  }
  async getClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return null;
    const { password_hash: _passwordHash, ...safe } = client;
    return clone(safe);
  }
  async createClientSession({ sessionId, clientId, tokenHash, expiresAt }) {
    const row = { session_id: sessionId, client_id: clientId, token_hash: tokenHash, expires_at: expiresAt, created_at: new Date().toISOString() };
    this.clientSessions.set(sessionId, row);
    return clone(row);
  }
  async getClientSession(tokenHash) {
    const session = [...this.clientSessions.values()].find((s) => s.token_hash === tokenHash && Date.parse(s.expires_at) > Date.now());
    return clone(session || null);
  }
  async deleteClientSession(tokenHash) {
    for (const [id, session] of this.clientSessions) {
      if (session.token_hash === tokenHash) return this.clientSessions.delete(id);
    }
    return false;
  }
  async deleteExpiredClientSessions() {
    for (const [id, session] of this.clientSessions) {
      if (Date.parse(session.expires_at) <= Date.now()) this.clientSessions.delete(id);
    }
  }
  async checkClientAuthRateLimit({ rateKey, max, windowMs }) {
    const now = Date.now();
    let bucket = this.clientAuthRateLimits.get(rateKey);
    if (!bucket || now - bucket.windowStarted >= windowMs) {
      bucket = { windowStarted: now, hitCount: 0 };
      this.clientAuthRateLimits.set(rateKey, bucket);
    }
    bucket.hitCount = Math.min(bucket.hitCount + 1, max + 1);
    return {
      allowed: bucket.hitCount <= max,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStarted + windowMs - now) / 1000)),
    };
  }
  async createOtpChallenge({ challengeHash, clientId, otpHash, expiresAt, resendAfter }) {
    for (const [hash, challenge] of this.otpChallenges) {
      if (challenge.client_id === clientId && !challenge.consumed_at) challenge.consumed_at = new Date().toISOString();
      if (Date.parse(challenge.expires_at) <= Date.now()) this.otpChallenges.delete(hash);
    }
    this.otpChallenges.set(challengeHash, {
      challenge_hash: challengeHash, client_id: clientId, otp_hash: otpHash, attempts: 0,
      expires_at: expiresAt, resend_after: resendAfter, consumed_at: null,
    });
  }
  async invalidateOtpChallenge(challengeHash) {
    const challenge = this.otpChallenges.get(challengeHash);
    if (challenge && !challenge.consumed_at) challenge.consumed_at = new Date().toISOString();
  }
  async getOtpChallengeAccount(challengeHash) {
    const challenge = this.otpChallenges.get(challengeHash);
    if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= Date.now()) return null;
    const account = this.clients.get(challenge.client_id);
    return account ? { client_id: account.client_id, email: account.email } : null;
  }
  async resendOtpChallenge({ challengeHash, otpHash, now, expiresAt, resendAfter }) {
    const challenge = this.otpChallenges.get(challengeHash);
    if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= now) return { status: "expired" };
    if (Date.parse(challenge.resend_after) > now) return { status: "cooldown", resendAfter: challenge.resend_after };
    challenge.otp_hash = otpHash;
    challenge.attempts = 0;
    challenge.expires_at = expiresAt;
    challenge.resend_after = resendAfter;
    return { status: "sent", clientId: challenge.client_id };
  }
  async verifyOtpChallenge({ challengeHash, otpHash, now, maxAttempts, session }) {
    const challenge = this.otpChallenges.get(challengeHash);
    if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= now) return { status: "expired" };
    if (challenge.attempts >= maxAttempts) return { status: "locked" };
    const { safeEqualHex } = require("../client-otp");
    if (!safeEqualHex(challenge.otp_hash, otpHash)) {
      challenge.attempts += 1;
      if (challenge.attempts >= maxAttempts) challenge.consumed_at = new Date().toISOString();
      return { status: challenge.attempts >= maxAttempts ? "locked" : "incorrect" };
    }
    challenge.consumed_at = new Date().toISOString();
    const account = await this.getClient(challenge.client_id);
    if (!account) return { status: "expired" };
    await this.createClientSession({
      sessionId: session.sessionId, clientId: challenge.client_id,
      tokenHash: session.tokenHash, expiresAt: session.expiresAt,
    });
    return { status: "verified", account };
  }
  async listBillingPlans() { return [...this.billingPlans.values()].map(clone); }
  async upsertBillingPlan(plan) {
    const row = {
      plan_id: plan.planId, name: plan.name, currency: "INR",
      monthly_fee_paise: String(plan.monthlyFeePaise || 0),
      storage_paise_per_gb_month: String(plan.storagePaisePerGbMonth),
      requests_per_unit: String(plan.requestsPerUnit), request_unit_paise: String(plan.requestUnitPaise),
      transfer_paise_per_gb: String(plan.transferPaisePerGb), active: Boolean(plan.active),
      pricing_configured: plan.pricingConfigured !== false,
    };
    this.billingPlans.set(plan.planId, row);
    return clone(row);
  }
  async getActiveBillingPlan() { return clone([...this.billingPlans.values()].find((plan) => plan.active) || null); }
  async getClientSubscription(clientId) {
    let subscription = this.clientBillingSubscriptions.get(clientId);
    if (!subscription) return null;
    const today = new Date().toISOString().slice(0, 10);
    if (subscription.pending_effective_at && subscription.pending_effective_at <= today) {
      const effective = new Date(`${subscription.pending_effective_at}T00:00:00.000Z`);
      subscription.plan_id = subscription.pending_plan_id;
      subscription.pending_plan_id = null;
      subscription.period_start = subscription.pending_effective_at;
      subscription.period_end = new Date(Date.UTC(effective.getUTCFullYear(), effective.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      subscription.pending_effective_at = null;
      subscription.updated_at = new Date().toISOString();
    }
    return {
      subscription: clone(subscription),
      plan: clone(this.billingPlans.get(subscription.plan_id) || null),
      pendingPlan: clone(subscription.pending_plan_id
        ? this.billingPlans.get(subscription.pending_plan_id) || null
        : null),
    };
  }
  async setClientSubscription({ clientId, planId }) {
    const plan = this.billingPlans.get(planId);
    if (!plan || !plan.active || !plan.pricing_configured) {
      throw conflict("That billing plan is not available or does not have configured pricing.");
    }
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const existing = this.clientBillingSubscriptions.get(clientId);
    const sameCurrent = existing && existing.plan_id === planId;
    const subscription = existing ? {
      ...existing,
      pending_plan_id: sameCurrent ? null : planId,
      pending_effective_at: sameCurrent ? null : new Date(`${existing.period_end}T00:00:00.000Z`).toISOString().slice(0, 10),
      updated_at: now.toISOString(),
    } : {
      subscription_id: `sub_${crypto.randomBytes(12).toString("hex")}`,
      client_id: clientId, plan_id: planId, pending_plan_id: null,
      pending_effective_at: null, status: "active", period_start: periodStart,
      period_end: periodEnd, created_at: now.toISOString(), updated_at: now.toISOString(),
    };
    if (existing && !sameCurrent) {
      const nextPeriod = new Date(`${existing.period_end}T00:00:00.000Z`);
      nextPeriod.setUTCDate(nextPeriod.getUTCDate() + 1);
      subscription.pending_effective_at = nextPeriod.toISOString().slice(0, 10);
    }
    this.clientBillingSubscriptions.set(clientId, subscription);
    return clone(subscription);
  }
  async recordUsageEvent(event) {
    const key = `${event.requestId}\0${event.category}`;
    if (!this.usageEvents.has(key)) this.usageEvents.set(key, { ...event });
  }
  async reconcileDailyUsage({ start, end, projectId = null }) {
    const aggregates = new Map();
    for (const event of this.usageEvents.values()) {
      const date = new Date(event.occurredAt).toISOString().slice(0, 10);
      if (date < start || date > end || (projectId && event.projectId !== projectId)) continue;
      const key = `${event.projectId}\0${date}`;
      const row = aggregates.get(key) || {
        project_id: event.projectId, usage_date: date, api_requests: 0,
        outbound_bytes: 0, transfer_available: true,
      };
      if (event.category === "api_requests") row.api_requests += Number(event.quantity || 0);
      else if (!event.available) {
        row.outbound_bytes = null;
        row.transfer_available = false;
      } else if (row.transfer_available) row.outbound_bytes += Number(event.quantity || 0);
      aggregates.set(key, row);
    }
    for (const [key, row] of aggregates) this.dailyUsage.set(key, row);
  }
  async recordStorageSnapshot({ projectId, date, storageBytes, available, reason = null }) {
    this.storageSnapshots.set(`${projectId}\0${date}`, {
      project_id: projectId, snapshot_date: date, storage_bytes: storageBytes,
      available: Boolean(available), reason, measured_at: new Date().toISOString(),
    });
  }
  async getBillingOverview(clientId, start, end) {
    const projectRows = [...this.projects.values()]
      .filter((project) => project.owner_client_id === clientId && project.status !== "deleted")
      .map((project) => ({ project_id: project.project_id, created_at: project.created_at }));
    const daily = [];
    const endTime = Date.parse(`${end}T00:00:00.000Z`);
    for (const project of projectRows) {
      const projectId = project.project_id;
      const startTime = Math.max(Date.parse(`${start}T00:00:00.000Z`), Date.parse(`${project.created_at.slice(0, 10)}T00:00:00.000Z`));
      for (let time = startTime; time <= endTime; time += 86400000) {
        const date = new Date(time).toISOString().slice(0, 10);
        const day = this.dailyUsage.get(`${projectId}\0${date}`);
        const snapshot = this.storageSnapshots.get(`${projectId}\0${date}`);
        daily.push({
          project_id: projectId, usage_date: date,
          api_requests: day ? day.api_requests : 0,
          outbound_bytes: day ? day.outbound_bytes : 0,
          transfer_available: day ? day.transfer_available : true,
          storage_bytes: snapshot ? snapshot.storage_bytes : null,
          storage_available: Boolean(snapshot && snapshot.available),
          storage_reason: snapshot ? snapshot.reason : null,
        });
      }
    }
    const clientSubscription = await this.getClientSubscription(clientId);
    return {
      projects: projectRows,
      daily,
      plan: clientSubscription ? clientSubscription.plan : await this.getActiveBillingPlan(),
      subscription: clientSubscription ? clientSubscription.subscription : null,
      pendingPlan: clientSubscription ? clientSubscription.pendingPlan : null,
      profile: clone(this.billingProfiles.get(clientId) || null),
    };
  }
  async saveBillingProfile(clientId, profile) {
    const row = {
      client_id: clientId, billing_name: profile.billingName || null,
      billing_address: profile.billingAddress || null, billing_contact: profile.billingContact || null,
      purchase_order: profile.purchaseOrder || null, updated_at: new Date().toISOString(),
    };
    this.billingProfiles.set(clientId, row);
    return clone(row);
  }
  async listClientBillingProfiles() {
    return [...this.clients.values()].map((account) => {
      const profile = this.billingProfiles.get(account.client_id) || {};
      return {
        client_id: account.client_id, email: account.email, display_name: account.display_name,
        created_at: account.created_at, billing_name: profile.billing_name || null,
        billing_address: profile.billing_address || null, billing_contact: profile.billing_contact || null,
        purchase_order: profile.purchase_order || null,
        project_count: [...this.projects.values()].filter((p) => p.owner_client_id === account.client_id && p.status !== "deleted").length,
      };
    });
  }
  async createDraftInvoice(data) {
    const existing = [...this.invoices.values()].find((invoice) =>
      invoice.client_id === data.clientId && invoice.period_start === data.periodStart && invoice.period_end === data.periodEnd);
    if (existing) return { ...(await this.getInvoice(existing.invoice_id)), replayed: true };
    this._invoiceSeq += 1;
    const invoiceNumber = `MST-${data.periodStart.slice(0, 4)}-${String(this._invoiceSeq).padStart(6, "0")}`;
    const row = {
      invoice_id: data.invoiceId, invoice_number: invoiceNumber, client_id: data.clientId,
      period_start: data.periodStart, period_end: data.periodEnd, due_date: null,
      status: "draft", currency: "INR", subtotal_paise: String(data.subtotalPaise),
      discount_paise: "0", credit_paise: "0", adjustment_paise: "0", tax_paise: "0",
      amount_due_paise: String(data.subtotalPaise), paid_paise: "0", demo: true,
      plan_snapshot: clone(data.planSnapshot), client_snapshot: clone(data.clientSnapshot),
      issued_snapshot: null, created_at: new Date().toISOString(), issued_at: null,
    };
    this.invoices.set(row.invoice_id, row);
    this.invoiceItems.set(row.invoice_id, data.items.map((item, index) => ({
      invoice_id: row.invoice_id, line_number: index + 1, description: item.description,
      service: item.service, quantity: item.quantity, unit: item.unit,
      unit_price_paise: String(item.unitPricePaise), unit_price_label: item.unitPriceLabel || null,
      amount_paise: String(item.amountPaise), usage_period: item.usagePeriod,
      usage_snapshot: clone(item),
    })));
    await this.auditBilling({
      invoiceId: row.invoice_id, clientId: row.client_id, actor: data.actor,
      action: "draft.created", reason: "Generated from reconciled usage",
    });
    return this.getInvoice(row.invoice_id);
  }
  async getInvoiceByPeriod(clientId, start, end) {
    const invoice = [...this.invoices.values()].find((item) =>
      item.client_id === clientId && item.period_start === start && item.period_end === end);
    return invoice ? this.getInvoice(invoice.invoice_id) : null;
  }
  async getInvoice(invoiceId) {
    const invoice = this.invoices.get(invoiceId);
    return invoice ? {
      ...clone(invoice), items: clone(this.invoiceItems.get(invoiceId) || []),
      payments: clone(this.invoicePayments.get(invoiceId) || []),
    } : null;
  }
  async listInvoicesForClient(clientId) {
    return Promise.all([...this.invoices.values()].filter((invoice) => invoice.client_id === clientId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).map((invoice) => this.getInvoice(invoice.invoice_id)));
  }
  async listAllInvoices() {
    return Promise.all([...this.invoices.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 500).map((invoice) => this.getInvoice(invoice.invoice_id)));
  }
  async auditBilling(event) { this.billingAudit.push({ ...event, audit_id: this.billingAudit.length + 1, occurred_at: new Date().toISOString() }); }
  async transitionInvoice(invoiceId, status, actor, reason, dueDate = null) {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) return null;
    if (status === "reviewed" && invoice.status !== "draft") throw conflict("Only a draft invoice can be marked reviewed.");
    if (status === "issued" && invoice.status !== "reviewed") throw conflict("Only a reviewed invoice can be issued.");
    if (status === "void" && (["paid", "void"].includes(invoice.status) || BigInt(invoice.paid_paise) > 0n)) {
      throw conflict("Invoices with recorded payments or an existing void cannot be voided.");
    }
    invoice.status = status;
    if (status === "issued") {
      invoice.issued_at = new Date().toISOString();
      invoice.due_date = dueDate;
      const client = invoice.client_snapshot || {};
      invoice.issued_snapshot = {
        invoiceNumber: invoice.invoice_number,
        clientId: invoice.client_id,
        clientName: client.billingName || client.displayName || "Client",
        clientEmail: client.email || "",
        purchaseOrder: client.purchaseOrder || null,
        billingAddress: client.billingAddress || null,
        periodStart: invoice.period_start,
        periodEnd: invoice.period_end,
        dueDate,
        status: "issued",
        issuedAt: invoice.issued_at,
        subtotalPaise: invoice.subtotal_paise,
        taxPaise: invoice.tax_paise,
        paidPaise: "0",
        amountDuePaise: invoice.amount_due_paise,
        items: (this.invoiceItems.get(invoiceId) || []).map((item) => ({
          description: item.description, service: item.service, quantity: item.quantity,
          unit: item.unit, unitPricePaise: item.unit_price_paise,
          unitPriceLabel: item.unit_price_label, amountPaise: item.amount_paise,
          usagePeriod: item.usage_period,
        })),
      };
    }
    await this.auditBilling({ invoiceId, clientId: invoice.client_id, actor, action: `invoice.${status}`, reason });
    return this.getInvoice(invoiceId);
  }
  async recordInvoicePayment({ invoiceId, paymentId, amountPaise, reference, actor }) {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) return null;
    if (!["issued", "partially_paid", "overdue"].includes(invoice.status)) throw conflict("Payments can only be recorded against an issued invoice.");
    const paid = BigInt(invoice.paid_paise) + BigInt(amountPaise);
    if (paid > BigInt(invoice.amount_due_paise)) throw conflict("Payment exceeds the outstanding invoice balance.");
    const payment = {
      payment_id: paymentId, invoice_id: invoiceId, amount_paise: String(amountPaise),
      payment_reference: reference, recorded_by: actor, recorded_at: new Date().toISOString(),
    };
    const payments = this.invoicePayments.get(invoiceId) || [];
    payments.push(payment);
    this.invoicePayments.set(invoiceId, payments);
    invoice.paid_paise = paid.toString();
    invoice.status = paid === BigInt(invoice.amount_due_paise) ? "paid" : "partially_paid";
    await this.auditBilling({
      invoiceId, clientId: invoice.client_id, actor, action: "payment.recorded",
      reason: "Manual payment recorded; no payment was processed", detail: { amountPaise, reference },
    });
    return this.getInvoice(invoiceId);
  }
  async listInvoicePaymentsForClient(clientId) {
    const invoices = [...this.invoices.values()].filter((invoice) => invoice.client_id === clientId);
    return invoices.flatMap((invoice) => (this.invoicePayments.get(invoice.invoice_id) || []).map((payment) => ({
      ...clone(payment), invoice_number: invoice.invoice_number, client_id: clientId,
    })));
  }
  async listBillingAudit(limit = 200) { return clone(this.billingAudit.slice(-limit).reverse()); }

  _ck(projectId, name) { return `${projectId}\u0000${name}`; }

  async createCollectionWithMapping(collection, mapping) {
    const k = this._ck(collection.project_id, collection.name);
    if (this.collections.has(k)) throw conflict(`Collection "${collection.name}" already exists.`);
    this.collections.set(k, { ...collection, status: "active", created_at: new Date().toISOString() });
    this.mappings.set(k, { ...mapping, created_at: new Date().toISOString() });
    return { collection: clone(this.collections.get(k)), mapping: clone(this.mappings.get(k)) };
  }
  async getCollection(projectId, name) { return clone(this.collections.get(this._ck(projectId, name)) || null); }
  async listCollections(projectId) {
    return [...this.collections.values()].filter((c) => c.project_id === projectId && c.status !== "deleted").map(clone);
  }
  async getMapping(projectId, collection) { return clone(this.mappings.get(this._ck(projectId, collection)) || null); }
  async listMappings(projectId) {
    return [...this.mappings.values()].filter((m) => m.project_id === projectId).map(clone);
  }
  async deleteCollection(projectId, name) {
    const k = this._ck(projectId, name);
    const existed = this.collections.delete(k);
    this.mappings.delete(k);
    return existed;
  }
  async deleteAllCollections(projectId) {
    for (const k of [...this.collections.keys()]) if (k.startsWith(`${projectId}\u0000`)) { this.collections.delete(k); this.mappings.delete(k); }
  }

  _emptyUsage(projectId) {
    return { project_id: projectId, requests: 0, queries: 0, inserts: 0, updates: 0, deletes: 0, errors: 0, storage_bytes: 0, last_activity: null };
  }
  async incrementUsage(projectId, deltas) {
    const u = this.usage.get(projectId) || this._emptyUsage(projectId);
    for (const f of USAGE_FIELDS) u[f] += Number(deltas[f] || 0);
    u.last_activity = new Date().toISOString();
    this.usage.set(projectId, u);
  }
  async setStorageBytes(projectId, bytes) {
    const u = this.usage.get(projectId) || this._emptyUsage(projectId);
    u.storage_bytes = bytes;
    this.usage.set(projectId, u);
  }
  async getUsage(projectId) { return clone(this.usage.get(projectId) || this._emptyUsage(projectId)); }
}

module.exports = { MemoryControlStore, USAGE_FIELDS };
