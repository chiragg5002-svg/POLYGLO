/* Operator-only control-plane workflows for the Developer Platform. */
(function () {
  const tokenInput = document.getElementById("platform-admin-token");
  if (!tokenInput) return;

  const $ = (id) => document.getElementById(id);
  const esc = (value) => (value === null || value === undefined ? "" : String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
  const STORE_LABEL = { postgresql: "PostgreSQL", mongodb: "MongoDB", elasticsearch: "Elasticsearch" };
  const TOKEN_KEY = "maestro_admin_token";
  let authenticated = false;
  let selected = null;
  let billingPlans = [];
  let selectionVersion = 0;
  let projectMutationRunning = false;
  let authVerificationRunning = false;

  function setStatus(message, isError = false) {
    const element = $("platform-status");
    element.textContent = message || "";
    element.className = isError ? "status error" : "status";
  }

  function setAuthStatus(message, isError = false) {
    const element = $("platform-auth-status");
    element.textContent = message || "";
    element.className = isError ? "status error" : "status";
  }

  function setAuthenticated(value) {
    authenticated = value;
    window.maestroOperatorAuthenticated = value;
    $("platform-create-project").disabled = !value || projectMutationRunning;
    $("platform-refresh").disabled = !value;
    [
      "billing-admin-client", "billing-admin-refresh", "billing-snapshot", "billing-reconcile",
      "billing-draft", "billing-export-kind", "billing-export", "billing-plan-save",
    ].forEach((id) => { if ($(id)) $(id).disabled = !value; });
    if (value) {
      document.querySelectorAll("form[action^='/database/'] button[type='submit'], #query-submit")
        .forEach((button) => { button.disabled = false; });
    } else {
      document.querySelectorAll("form[action^='/database/'] button[type='submit'], #query-submit")
        .forEach((button) => { button.disabled = true; });
    }
  }

  function invalidateToken(message) {
    sessionStorage.removeItem(TOKEN_KEY);
    tokenInput.value = "";
    selected = null;
    $("platform-secret").replaceChildren();
    $("platform-project-list").innerHTML = '<p class="note">Sign in to load projects.</p>';
    $("platform-project-detail").innerHTML = '<p class="note">Sign in and select a project to see its collections, keys, usage and activity.</p>';
    $("billing-admin-client").innerHTML = '<option value="">Sign in to load clients</option>';
    $("billing-client-profiles").innerHTML = '<p class="note">Operator sign-in required.</p>';
    $("billing-invoice-list").innerHTML = '<p class="note">Operator sign-in required.</p>';
    $("billing-audit-list").innerHTML = '<p class="note">Operator sign-in required.</p>';
    setBillingStatus("");
    setAuthenticated(false);
    setAuthStatus(message, true);
    window.dispatchEvent(new Event("maestro:operator-auth-changed"));
  }

  async function api(method, path, body) {
    if (!sessionStorage.getItem(TOKEN_KEY)) {
      const error = new Error("Enter MAESTRO_ADMIN_TOKEN and verify it to use operator actions.");
      error.status = 401;
      throw error;
    }
    let response;
    try {
      response = await window.maestroOperatorFetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(error.message || "The operator request could not be sent.");
    }
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const message = data.message || data.error?.message || `Request failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      if (response.status === 401) invalidateToken("Operator token was rejected. Check MAESTRO_ADMIN_TOKEN and verify again.");
      if (response.status === 503 && /operator access is not configured/i.test(message)) {
        error.message = "Operator access is not configured on the server. Set MAESTRO_ADMIN_TOKEN and restart the API.";
      }
      throw error;
    }
    return data;
  }

  function billingMoney(paise) {
    const amount = BigInt(paise || 0);
    return `₹${(amount / 100n).toLocaleString("en-IN")}.${String(amount % 100n).padStart(2, "0")}`;
  }

  function setBillingStatus(message, isError = false) {
    const status = $("billing-admin-status");
    status.textContent = message || "";
    status.className = isError ? "status error" : "status";
  }

  async function loadBillingAdmin() {
    if (!authenticated) return;
    setBillingStatus("Loading billing profiles, pricing, invoices and audit history…");
    try {
      const [clientsResponse, plansResponse, invoicesResponse, auditResponse] = await Promise.all([
        api("GET", "/v1/billing/clients"),
        api("GET", "/v1/billing/plans"),
        api("GET", "/v1/billing/invoices"),
        api("GET", "/v1/billing/audit?limit=100"),
      ]);
      const clients = clientsResponse.clients || [];
      const selectedClient = $("billing-admin-client").value;
      $("billing-admin-client").innerHTML = '<option value="">Select a client</option>' + clients.map((client) =>
        `<option value="${esc(client.client_id)}">${esc(client.billing_name || client.display_name)} · ${esc(client.email)}</option>`,
      ).join("");
      $("billing-admin-client").value = clients.some((client) => client.client_id === selectedClient) ? selectedClient : "";
      $("billing-client-profiles").innerHTML = clients.length ? `<table><thead><tr>
        <th>Client</th><th>Email</th><th>Billing name</th><th>Projects</th><th>Reference</th>
        </tr></thead><tbody>${clients.map((client) => `<tr>
          <td>${esc(client.display_name)}</td><td>${esc(client.email)}</td>
          <td>${esc(client.billing_name || "Not provided")}</td><td>${esc(client.project_count)}</td>
          <td>${esc(client.purchase_order || "—")}</td></tr>`).join("")}</tbody></table>`
        : '<p class="note">No client accounts.</p>';
      billingPlans = plansResponse.plans || [];
      const currentPlanId = $("billing-plan-id").value;
      $("billing-plan-id").innerHTML = billingPlans.map((item) =>
        `<option value="${esc(item.plan_id)}">${esc(item.name)} (${esc(item.plan_id)})${item.pricing_configured ? "" : " — pricing needed"}</option>`,
      ).join("");
      const plan = billingPlans.find((item) => item.plan_id === currentPlanId) ||
        billingPlans.find((item) => item.active) || billingPlans[0];
      if (plan) {
        $("billing-plan-id").value = plan.plan_id;
        $("billing-plan-name").value = plan.name;
        $("billing-monthly-fee").value = plan.monthly_fee_paise || 0;
        $("billing-storage-rate").value = plan.storage_paise_per_gb_month;
        $("billing-request-unit").value = plan.requests_per_unit;
        $("billing-request-rate").value = plan.request_unit_paise;
        $("billing-transfer-rate").value = plan.transfer_paise_per_gb;
      }
      const invoices = invoicesResponse.invoices || [];
      $("billing-invoice-list").innerHTML = invoices.length ? `<table><thead><tr>
        <th>Invoice</th><th>Client</th><th>Period</th><th>Status</th><th>Amount due</th><th>Actions</th>
        </tr></thead><tbody>${invoices.map((invoice) => `<tr>
          <td>${esc(invoice.invoiceNumber)}</td><td>${esc(invoice.clientId)}</td>
          <td>${esc(invoice.periodStart)} – ${esc(invoice.periodEnd)}</td><td>${esc(invoice.status)}</td>
          <td>${billingMoney(invoice.amountDuePaise)}</td><td>
          ${invoice.status === "draft" ? `<button class="small" type="button" data-review-invoice="${esc(invoice.invoiceId)}">Review</button>` : ""}
          ${invoice.status === "reviewed" ? `<button class="small" type="button" data-issue-invoice="${esc(invoice.invoiceId)}">Issue</button>` : ""}
          ${!["paid", "void"].includes(invoice.status) ? `<button class="small danger" type="button" data-void-invoice="${esc(invoice.invoiceId)}">Void</button>` : ""}
          ${["issued", "partially_paid", "overdue"].includes(invoice.status) ? `<button class="small secondary" type="button" data-pay-invoice="${esc(invoice.invoiceId)}">Record payment</button>` : ""}
          </td></tr>`).join("")}</tbody></table>`
        : '<p class="note">No invoices yet.</p>';
      $("billing-invoice-list").querySelectorAll("[data-review-invoice]").forEach((button) =>
          button.addEventListener("click", async () => {
            const reason = prompt("Reason for reviewing this invoice:");
            if (!reason) return;
            button.disabled = true;
            try {
              await api("POST", `/v1/billing/invoices/${encodeURIComponent(button.dataset.reviewInvoice)}/review`, { reason });
              setBillingStatus("Invoice marked reviewed.");
              await loadBillingAdmin();
            } catch (error) { setBillingStatus(error.message, true); button.disabled = false; }
          }));
      $("billing-invoice-list").querySelectorAll("[data-issue-invoice]").forEach((button) =>
        button.addEventListener("click", async () => {
          const reason = prompt("Reason for issuing this invoice:");
          if (!reason) return;
          button.disabled = true;
          try {
            await api("POST", `/v1/billing/invoices/${encodeURIComponent(button.dataset.issueInvoice)}/issue`, { reason });
            setBillingStatus("Invoice issued.");
            await loadBillingAdmin();
          } catch (error) { setBillingStatus(error.message, true); button.disabled = false; }
        }));
      $("billing-invoice-list").querySelectorAll("[data-void-invoice]").forEach((button) =>
        button.addEventListener("click", async () => {
          const reason = prompt("Auditable reason for voiding this invoice:");
          if (!reason) return;
          button.disabled = true;
          try {
            await api("POST", `/v1/billing/invoices/${encodeURIComponent(button.dataset.voidInvoice)}/void`, { reason });
            setBillingStatus("Invoice voided.");
            await loadBillingAdmin();
          } catch (error) { setBillingStatus(error.message, true); button.disabled = false; }
        }));
      $("billing-invoice-list").querySelectorAll("[data-pay-invoice]").forEach((button) =>
        button.addEventListener("click", async () => {
          const amountPaise = prompt("Amount received in paise (integer):");
          if (!amountPaise) return;
          const reference = prompt("Payment reference:");
          if (!reference) return;
          button.disabled = true;
          try {
            await api("POST", "/v1/billing/payments", { invoiceId: button.dataset.payInvoice, amountPaise, reference });
            setBillingStatus("Manual payment record saved. No payment was processed.");
            await loadBillingAdmin();
          } catch (error) { setBillingStatus(error.message, true); button.disabled = false; }
        }));
      const audit = auditResponse.events || [];
      $("billing-audit-list").innerHTML = audit.length ? `<table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Reason</th></tr></thead>
        <tbody>${audit.map((event) => `<tr><td>${esc(event.occurred_at)}</td><td>${esc(event.actor)}</td>
          <td>${esc(event.action)}</td><td>${esc(event.reason)}</td></tr>`).join("")}</tbody></table>`
        : '<p class="note">No billing audit events.</p>';
      setBillingStatus("");
    } catch (error) {
      setBillingStatus(error.message, true);
    }
  }

  function bytes(value) {
    if (value === null || value === undefined) return "Unavailable";
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "Unavailable";
    if (number < 1024) return `${number} B`;
    if (number < 1048576) return `${(number / 1024).toFixed(1)} KB`;
    return `${(number / 1048576).toFixed(1)} MB`;
  }

  function stat(label, value) {
    return `<div class="stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function emptyTableRow(columns, message) {
    return `<tr><td colspan="${columns}">${esc(message)}</td></tr>`;
  }

  async function loadProjects({ preserveStatus = false } = {}) {
    if (!authenticated) return [];
    const list = $("platform-project-list");
    list.innerHTML = '<p class="loading-text"><span class="spinner"></span>Loading projects…</p>';
    try {
      const response = await api("GET", "/v1/projects");
      const projects = Array.isArray(response.projects) ? response.projects : [];
      if (!projects.length) {
        list.innerHTML = '<p class="note">No projects exist yet. Create a project to get started.</p>';
        selected = null;
        $("platform-project-detail").innerHTML = '<p class="note">Select a project to inspect collections, API keys, usage and activity.</p>';
      } else {
        if (selected && !projects.some((project) => project.projectId === selected)) selected = null;
        list.innerHTML = projects.map((project) => `
          <button type="button" class="project-item ${project.projectId === selected ? "active" : ""}" data-id="${esc(project.projectId)}" aria-pressed="${project.projectId === selected}">
            <strong>${esc(project.name)}</strong><small>${esc(project.projectId)} · ${esc(project.status)}</small>
          </button>`).join("");
        list.querySelectorAll(".project-item").forEach((button) => {
          button.addEventListener("click", () => selectProject(button.dataset.id));
        });
      }
      if (!preserveStatus) setStatus("");
      return projects;
    } catch (error) {
      list.innerHTML = `<p class="error">${esc(error.message)}</p>`;
      setStatus(error.message, true);
      return [];
    }
  }

  function distribution(collections) {
    if (!collections.length) return '<p class="note">No collection storage mappings are available.</p>';
    const counts = {};
    collections.forEach((collection) => { counts[collection.dbType] = (counts[collection.dbType] || 0) + 1; });
    const maximum = Math.max(...Object.values(counts));
    return Object.entries(counts).map(([type, count]) => `
      <div class="dist-row"><span class="label">${esc(STORE_LABEL[type] || type)}</span>
        <span class="bar" style="width:${Math.round((count / maximum) * 160)}px"></span><span>${esc(count)}</span></div>`).join("");
  }

  function renderImports(imports) {
    if (!imports.length) return '<p class="note">No DBaaS API imports have been recorded for this project.</p>';
    return `<div class="query-results-table"><table><thead><tr><th>Import</th><th>Collection</th><th>Status</th><th>Rows</th><th>Created</th></tr></thead><tbody>
      ${imports.map((job) => `<tr>
        <td><code>${esc(job.import_id)}</code></td><td>${esc(job.collection)}</td>
        <td><span class="badge ${job.status === "completed" ? "success" : job.status === "failed" ? "error" : "pending"}">${esc(job.status)}</span></td>
        <td>${esc(job.inserted)} inserted / ${esc(job.failed)} failed of ${esc(job.total)}</td>
        <td>${esc(job.created_at ? new Date(job.created_at).toLocaleString() : "Unavailable")}</td>
      </tr>`).join("")}</tbody></table></div>`;
  }

  function renderActivity(events) {
    if (!events.length) return '<p class="note">No audit activity has been recorded for this project.</p>';
    return `<ul class="platform-activity">${events.map((event) => `
      <li><strong>${esc(event.action)}</strong>${event.target ? ` · ${esc(event.target)}` : ""}
        <small>${esc(event.actor)} · ${esc(event.at ? new Date(event.at).toLocaleString() : "Unavailable")}</small></li>`).join("")}</ul>`;
  }

  async function selectProject(projectId) {
    if (!authenticated) return;
    const version = ++selectionVersion;
    selected = projectId;
    $("platform-project-list").querySelectorAll(".project-item").forEach((button) => {
      const active = button.dataset.id === selected;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const box = $("platform-project-detail");
    box.innerHTML = '<p class="loading-text"><span class="spinner"></span>Loading project, collection, usage and activity data…</p>';
    try {
      const encodedId = encodeURIComponent(projectId);
      const [detail, usage, importResult, auditResult] = await Promise.all([
        api("GET", `/v1/projects/${encodedId}`),
        api("GET", `/v1/projects/${encodedId}/usage`),
        api("GET", `/v1/projects/${encodedId}/imports`),
        api("GET", `/v1/audit?projectId=${encodedId}&limit=20`),
      ]);
      if (version !== selectionVersion || selected !== projectId) return;
      const currentUsage = usage.usage || {};
      const perCollection = Object.fromEntries((usage.collections || []).map((collection) => [collection.name, collection]));
      const collections = Array.isArray(detail.collections) ? detail.collections : [];
      const keys = Array.isArray(detail.apiKeys) ? detail.apiKeys : [];
      const imports = Array.isArray(importResult.imports) ? importResult.imports : [];
      const events = Array.isArray(auditResult.events) ? auditResult.events : [];
      box.innerHTML = `
        <h3>${esc(detail.name)} <small class="note">${esc(detail.projectId)} · ${esc(detail.status)}</small></h3>
        <h4>Usage</h4>
        <div class="result-summary">
          ${stat("API requests", currentUsage.requests ?? "Unavailable")}${stat("Queries", currentUsage.queries ?? "Unavailable")}
          ${stat("Inserts", currentUsage.inserts ?? "Unavailable")}${stat("Updates", currentUsage.updates ?? "Unavailable")}
          ${stat("Deletes", currentUsage.deletes ?? "Unavailable")}${stat("Errors", currentUsage.errors ?? "Unavailable")}
          ${stat("Storage", currentUsage.storageBytes === undefined ? "Unavailable" : bytes(currentUsage.storageBytes))}
          ${stat("Last activity", currentUsage.lastActivity ? new Date(currentUsage.lastActivity).toLocaleString() : "No activity")}
        </div>
        ${(usage.warnings || []).length ? `<p class="warning-banner">${usage.warnings.map(esc).join(" ")}</p>` : ""}

        <h4>Collections</h4>
        ${collections.length ? `<div class="query-results-table"><table><thead><tr><th>Collection</th><th>Engine</th><th>Database / index</th><th>Physical table / collection</th><th>Documents</th><th>Size</th><th>Routing</th></tr></thead><tbody>
          ${collections.map((collection) => {
            const stats = perCollection[collection.collection] || {};
            return `<tr><td>${esc(collection.collection)}</td>
              <td><span class="badge store-${esc(collection.dbType)}">${esc(STORE_LABEL[collection.dbType] || collection.dbType)}</span></td>
              <td><code>${esc(collection.databaseName || "Not reported")}</code></td>
              <td><code>${esc(collection.physicalName || "Not reported")}</code></td>
              <td>${stats.documents === null || stats.documents === undefined ? "Unavailable" : esc(stats.documents)}</td>
              <td>${stats.storageBytes === undefined ? "Unavailable" : esc(bytes(stats.storageBytes))}</td>
              <td><small>${esc(collection.routingReason || "Not reported")}</small></td></tr>`;
          }).join("")}</tbody></table></div>` : '<p class="note">This project has no collections yet. They appear after a successful write or explicit collection creation.</p>'}

        <h4>Database distribution</h4>
        ${distribution(collections)}

        <h4>API keys</h4>
        ${keys.length ? `<div class="query-results-table"><table><thead><tr><th>Key prefix</th><th>Label</th><th>Scopes</th><th>Status</th><th>Expires</th><th>Last used</th><th>Actions</th></tr></thead><tbody>
          ${keys.map((key) => `<tr>
            <td><code>${esc(key.prefix)}</code></td><td>${esc(key.label || "—")}</td>
            <td><small>${esc((key.scopes || []).join(", "))}</small></td>
            <td><span class="badge ${key.status === "active" ? "success" : "error"}">${esc(key.status)}</span></td>
            <td><small>${esc(key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : "Never")}</small></td>
            <td><small>${esc(key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never")}</small></td>
            <td>${key.status === "active" ? `<button type="button" class="small secondary" data-rotate="${esc(key.keyId)}">Rotate</button> <button type="button" class="small danger" data-revoke="${esc(key.keyId)}">Revoke</button>` : ""}</td>
          </tr>`).join("")}</tbody></table></div>` : '<p class="note">No API keys are registered for this project.</p>'}
        <form id="platform-key-form" class="inline-form" novalidate>
          <label class="visually-hidden" for="platform-key-label">New key label (optional, maximum 60 characters)</label>
          <input id="platform-key-label" type="text" maxlength="60" placeholder="Label for a new key (optional)" />
          <button type="submit">Create new key</button>
        </form>

        <h4>DBaaS API imports</h4>
        <p class="note">This history covers uploads through the project-scoped DBaaS import API. Legacy operator file imports appear in Recent Metadata Activity.</p>
        ${renderImports(imports)}

        <h4>Recent project activity</h4>
        ${renderActivity(events)}

        <h4>Danger zone</h4>
        <label class="purge-option"><input type="checkbox" id="platform-purge" />
          Also permanently delete this project's stored data</label>
        <button type="button" id="platform-delete" class="danger">Delete project</button>`;

      box.querySelectorAll("[data-revoke]").forEach((button) => button.addEventListener("click", async () => {
        if (!confirm("Revoke this API key? Applications using it will stop working.")) return;
        button.disabled = true;
        try {
          await api("DELETE", `/v1/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(button.dataset.revoke)}`);
          setStatus("API key revoked.");
          await refreshSelectedProject();
        } catch (error) { setStatus(error.message, true); }
        finally { button.disabled = false; }
      }));
      box.querySelectorAll("[data-rotate]").forEach((button) => button.addEventListener("click", async () => {
        if (!confirm("Rotate this API key? The server issues a replacement and applies its configured grace period.")) return;
        button.disabled = true;
        try {
          const key = await api("POST", `/v1/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(button.dataset.rotate)}/rotate`, {});
          showSecret(key.apiKey, "Rotated API key");
          setStatus("API key rotated. Copy the replacement now; it is shown only once.");
          await refreshSelectedProject();
        } catch (error) { setStatus(error.message, true); }
        finally { button.disabled = false; }
      }));
      $("platform-key-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (form.dataset.submitting === "true") return;
        const labelInput = $("platform-key-label");
        const label = labelInput.value.trim();
        if (label.length > 60 || /[\u0000-\u001f]/.test(label)) {
          setStatus("Key label must be 60 characters or fewer and contain no control characters.", true);
          return;
        }
        form.dataset.submitting = "true";
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        setStatus("Creating API key…");
        try {
          const key = await api("POST", `/v1/projects/${encodeURIComponent(projectId)}/keys`, { label });
          showSecret(key.apiKey, "New API key");
          setStatus("API key created. Copy it now; its secret is shown only once.");
          await refreshSelectedProject();
        } catch (error) { setStatus(error.message, true); }
        finally { delete form.dataset.submitting; button.disabled = false; }
      });
      $("platform-delete").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        const purge = $("platform-purge").checked;
        const prompt = purge
          ? "Permanently delete this project AND all mapped data from its storage engines? This cannot be undone."
          : "Soft-delete this project and revoke its keys? Existing data will be retained.";
        if (!confirm(prompt)) return;
        button.disabled = true;
        setStatus(purge ? "Deleting project and stored data…" : "Deleting project…");
        try {
          const result = await api("DELETE", `/v1/projects/${encodeURIComponent(projectId)}${purge ? "?purge=true" : ""}`);
          selected = null;
          selectionVersion += 1;
          box.innerHTML = `<p class="note">Project deleted. Stored data ${result.dataPurged ? "was purged." : "was retained."}</p>`;
          await loadProjects({ preserveStatus: true });
          setStatus(result.dataPurged ? "Project and its stored data were deleted." : "Project deleted; stored data was retained.");
        } catch (error) {
          setStatus(error.message, true);
          button.disabled = false;
        }
      });
    } catch (error) {
      if (version !== selectionVersion) return;
      box.innerHTML = `<p class="error">${esc(error.message)}</p>`;
      setStatus(error.message, true);
    }
  }

  async function refreshSelectedProject() {
    const projectId = selected;
    const projects = await loadProjects({ preserveStatus: true });
    if (projectId && projects.some((project) => project.projectId === projectId)) {
      await selectProject(projectId);
    }
  }

  function showSecret(key, title) {
    $("platform-secret").innerHTML = `
      <div class="secret-box" role="status">
        <strong>${esc(title)} — copy it now; the secret is shown only once.</strong>
        <code>${esc(key)}</code>
        <button type="button" id="platform-copy-key" class="small">Copy secret</button>
        <button type="button" id="platform-hide-key" class="small secondary">Hide secret</button>
        <span id="platform-secret-status" class="note" role="status" aria-live="polite"></span>
      </div>`;
    $("platform-copy-key").addEventListener("click", async () => {
      try {
        if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
        await navigator.clipboard.writeText(key);
        $("platform-secret-status").textContent = "Copied. Store the key in a secure secret manager.";
      } catch {
        $("platform-secret-status").textContent = "Copy was blocked. Select and copy the secret manually.";
      }
    });
    $("platform-hide-key").addEventListener("click", () => $("platform-secret").replaceChildren());
  }

  async function verifyToken() {
    const button = $("platform-token-save");
    if (authVerificationRunning) return;
    const token = tokenInput.value.trim();
    if (!token) {
      invalidateToken("Enter MAESTRO_ADMIN_TOKEN to authenticate. Protected actions remain disabled.");
      return;
    }
    authVerificationRunning = true;
    button.disabled = true;
    setAuthStatus("Verifying operator credentials…");
    setAuthenticated(false);
    sessionStorage.setItem(TOKEN_KEY, token);
    try {
      const response = await api("GET", "/v1/projects");
      authenticated = true;
      setAuthenticated(true);
      setAuthStatus("Operator authenticated. Protected dashboard actions are enabled.");
      const projects = Array.isArray(response.projects) ? response.projects : [];
      await loadProjects({ preserveStatus: true });
      if (selected && projects.some((project) => project.projectId === selected)) await selectProject(selected);
      await loadBillingAdmin();
      window.dispatchEvent(new Event("maestro:operator-auth-changed"));
    } catch (error) {
      if (sessionStorage.getItem(TOKEN_KEY)) invalidateToken(error.status === 503
        ? "Operator access is not configured. Set MAESTRO_ADMIN_TOKEN on the server and restart the API."
        : error.message || "Operator authentication failed.");
      setStatus(error.message || "Operator authentication failed.", true);
    } finally {
      authVerificationRunning = false;
      button.disabled = false;
    }
  }

  $("platform-token-save").addEventListener("click", verifyToken);
  tokenInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      verifyToken();
    }
  });
  $("platform-token-clear").addEventListener("click", () => {
    invalidateToken("Operator signed out. Enter and verify a token to re-enable protected actions.");
    setStatus("");
  });
  $("platform-create-project").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!authenticated || projectMutationRunning) return;
    const name = $("platform-project-name").value.trim();
    if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) {
      setStatus("Enter a project name of 1–100 characters without control characters.", true);
      return;
    }
    projectMutationRunning = true;
    button.disabled = true;
    setStatus("Creating project…");
    try {
      const project = await api("POST", "/v1/projects", { name });
      if (project.replayed) {
        selected = project.projectId;
        await refreshSelectedProject();
        setStatus(project.note || "This request was already completed. Its original API key cannot be recovered.");
        return;
      }
      $("platform-project-name").value = "";
      showSecret(project.apiKey, `API key for "${project.name}" (${project.projectId})`);
      selected = project.projectId;
      await loadProjects({ preserveStatus: true });
      await selectProject(project.projectId);
      setStatus("Project created. Its API key is shown once; copy and store it securely.");
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      projectMutationRunning = false;
      button.disabled = !authenticated;
    }
  });
  $("platform-refresh").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!authenticated || button.disabled) return;
    button.disabled = true;
    setStatus("Refreshing project information…");
    try {
      const projectId = selected;
      const projects = await loadProjects({ preserveStatus: true });
      if (projectId && projects.some((project) => project.projectId === projectId)) await selectProject(projectId);
      setStatus("Project information refreshed.");
    } finally {
      button.disabled = !authenticated;
    }
  });
  const todayUtc = new Date().toISOString().slice(0, 10);
  $("billing-period-start").value = `${todayUtc.slice(0, 7)}-01`;
  $("billing-period-end").value = todayUtc;
  $("billing-admin-refresh").addEventListener("click", loadBillingAdmin);
  $("billing-plan-id").addEventListener("change", () => {
    const plan = billingPlans.find((item) => item.plan_id === $("billing-plan-id").value);
    if (!plan) return;
    $("billing-plan-name").value = plan.name;
    $("billing-monthly-fee").value = plan.monthly_fee_paise || 0;
    $("billing-storage-rate").value = plan.storage_paise_per_gb_month;
    $("billing-request-unit").value = plan.requests_per_unit;
    $("billing-request-rate").value = plan.request_unit_paise;
    $("billing-transfer-rate").value = plan.transfer_paise_per_gb;
  });
  $("billing-plan-save").addEventListener("click", async () => {
    const button = $("billing-plan-save");
    button.disabled = true;
    try {
      const planId = $("billing-plan-id").value.trim();
      await api("PUT", `/v1/billing/plans/${encodeURIComponent(planId)}`, {
        name: $("billing-plan-name").value.trim(),
        monthlyFeePaise: Number($("billing-monthly-fee").value),
        storagePaisePerGbMonth: Number($("billing-storage-rate").value),
        requestsPerUnit: Number($("billing-request-unit").value),
        requestUnitPaise: Number($("billing-request-rate").value),
        transferPaisePerGb: Number($("billing-transfer-rate").value),
        active: true,
        pricingConfigured: true,
      });
      setBillingStatus("INR pricing saved. Existing invoices retain their pricing snapshot.");
      await loadBillingAdmin();
    } catch (error) { setBillingStatus(error.message, true); }
    finally { button.disabled = !authenticated; }
  });
  $("billing-snapshot").addEventListener("click", async () => {
    const button = $("billing-snapshot");
    button.disabled = true;
    setBillingStatus("Measuring project-level logical storage…");
    try {
      const result = await api("POST", "/v1/billing/storage-snapshots", {});
      const unavailableCount = result.snapshots.filter((snapshot) => !snapshot.available).length;
      setBillingStatus(`Storage snapshots saved for ${result.snapshots.length} projects; ${unavailableCount} unavailable.`);
    } catch (error) { setBillingStatus(error.message, true); }
    finally { button.disabled = !authenticated; }
  });
  $("billing-reconcile").addEventListener("click", async () => {
    const button = $("billing-reconcile");
    button.disabled = true;
    try {
      const start = $("billing-period-start").value;
      const end = $("billing-period-end").value;
      await api("POST", "/v1/billing/reconcile", { start, end });
      setBillingStatus("Daily usage reconciled idempotently in UTC.");
      await loadBillingAdmin();
    } catch (error) { setBillingStatus(error.message, true); }
    finally { button.disabled = !authenticated; }
  });
  $("billing-draft").addEventListener("click", async () => {
    const button = $("billing-draft");
    const clientId = $("billing-admin-client").value;
    if (!clientId) return setBillingStatus("Select a client account first.", true);
    button.disabled = true;
    try {
      const result = await api("POST", "/v1/billing/invoices/drafts", {
        clientId, periodStart: $("billing-period-start").value, periodEnd: $("billing-period-end").value,
      });
      setBillingStatus(result.replayed ? "Existing invoice returned; no duplicate was created." : "Draft invoice generated from reconciled, measured usage.");
      await loadBillingAdmin();
    } catch (error) { setBillingStatus(error.message, true); }
    finally { button.disabled = !authenticated; }
  });
  $("billing-export").addEventListener("click", async () => {
    const kind = $("billing-export-kind").value;
    const params = new URLSearchParams({ kind });
    if (kind === "usage") {
      params.set("start", $("billing-period-start").value);
      params.set("end", $("billing-period-end").value);
    }
    const button = $("billing-export");
    button.disabled = true;
    try {
      const response = await window.maestroOperatorFetch(`/v1/billing/export.csv?${params}`, { method: "GET" });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const message = errorBody.message || `CSV export failed (${response.status}).`;
        if (response.status === 401) {
          invalidateToken("Operator token was rejected. Check MAESTRO_ADMIN_TOKEN and verify again.");
        }
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `maestro-billing-${kind}.csv`;
      link.click();
      URL.revokeObjectURL(blobUrl);
      setBillingStatus("CSV export downloaded.");
    } catch (error) { setBillingStatus(error.message, true); }
    finally { button.disabled = !authenticated; }
  });

  setAuthenticated(false);
  tokenInput.value = sessionStorage.getItem(TOKEN_KEY) || "";
  const savedToken = Boolean(tokenInput.value);
  if (savedToken) verifyToken();
})();
