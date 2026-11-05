(() => {
  const $ = (id) => document.getElementById(id);
  const authView = $("auth-view");
  const dashboard = $("dashboard");
  const projectsView = $("projects-view");
  const authStatus = $("auth-status");
  const portalStatus = $("portal-status");
  let selectedProjectId = null;
  let projects = [];
  const BROWSE_PAGE_SIZE = 50;
  let browseOffset = 0;
  let browseRecords = [];
  let projectSubmissionKey = null;
  let projectSubmissionFingerprint = null;

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function normalizeApiPath(path) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) {
      throw new Error("Client Portal requests must use the MAESTRO origin.");
    }
    url.pathname = url.pathname.replace(/^(?:\/v1){2,}(?=\/|$)/, "/v1");
    return `${url.pathname}${url.search}${url.hash}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(normalizeApiPath(path), {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.message || result.error?.message || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function setStatus(element, message, error = false) {
    element.textContent = message;
    element.classList.toggle("error", error);
  }

  function clearBrowse(message = "Select a project and collection.") {
    browseRecords = [];
    $("browse-head").replaceChildren();
    $("browse-body").replaceChildren();
    $("browse-table-wrap").hidden = true;
    $("browse-empty").hidden = true;
    $("browse-count").textContent = "";
    $("browse-search").value = "";
    $("browse-search").disabled = true;
    $("browse-previous").disabled = true;
    $("browse-next").disabled = true;
    $("browse-refresh").disabled = !$("browse-collection").value;
    $("browse-page-label").textContent = "Page 1";
    setStatus($("browse-status"), "");
    $("browse-collection-info").textContent = message;
  }

  function browseValue(value) {
    if (value === null || value === undefined) return "";
    return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  }

  function renderBrowseTimestamp(value, cell) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      cell.textContent = browseValue(value);
      return;
    }
    const time = document.createElement("time");
    time.dateTime = date.toISOString();
    time.title = browseValue(value);
    time.textContent = date.toLocaleString();
    cell.appendChild(time);
  }

  function renderBrowseRecords() {
    const search = $("browse-search").value.trim().toLowerCase();
    const visible = search
      ? browseRecords.filter((record) => JSON.stringify(record).toLowerCase().includes(search))
      : browseRecords;
    const head = $("browse-head");
    const body = $("browse-body");
    head.replaceChildren();
    body.replaceChildren();

    const fields = [...new Set(browseRecords.flatMap((record) => {
      const data = record && record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data
        : {};
      return Object.keys(data);
    }))];
    const hasCreated = browseRecords.some((record) => record.createdAt || record.created_at);
    const hasUpdated = browseRecords.some((record) => record.updatedAt || record.updated_at);
    const columns = ["Record ID", ...fields, ...(hasCreated ? ["Created"] : []), ...(hasUpdated ? ["Updated"] : [])];
    if (!fields.length) columns.splice(1, 0, "Data");
    for (const label of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      head.appendChild(th);
    }

    for (const record of visible) {
      const row = document.createElement("tr");
      const data = record && record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data
        : {};
      const values = [
        record && (record.id ?? record._id),
        ...(fields.length ? fields.map((field) => data[field]) : [record && record.data]),
        ...(hasCreated ? [record && (record.createdAt || record.created_at)] : []),
        ...(hasUpdated ? [record && (record.updatedAt || record.updated_at)] : []),
      ];
      const metadataStart = 1 + (fields.length || 1);
      const createdIndex = hasCreated ? metadataStart : -1;
      const updatedIndex = hasUpdated ? metadataStart + (hasCreated ? 1 : 0) : -1;
      values.forEach((value, index) => {
        const td = document.createElement("td");
        if (index === createdIndex || index === updatedIndex) {
          renderBrowseTimestamp(value, td);
        } else {
          td.textContent = browseValue(value);
        }
        row.appendChild(td);
      });
      body.appendChild(row);
    }

    $("browse-count").textContent =
      `Showing ${visible.length} of ${browseRecords.length} records loaded on this page (up to ${BROWSE_PAGE_SIZE}). Further records may exist. Search applies only to this page.`;
    $("browse-empty").hidden = browseRecords.length > 0;
    $("browse-table-wrap").hidden = browseRecords.length === 0;
    $("browse-search").disabled = false;
  }

  async function loadBrowse(offset = browseOffset) {
    const projectId = $("browse-project").value;
    const collectionName = $("browse-collection").value;
    const apiKey = $("browse-api-key").value.trim();
    if (!projectId || !collectionName) {
      setStatus($("browse-status"), "Select a project and collection.", true);
      return;
    }
    if (!apiKey) {
      setStatus($("browse-status"), "Enter a project API key with the data:read permission.", true);
      return;
    }

    browseOffset = offset;
    $("browse-refresh").disabled = true;
    $("browse-previous").disabled = true;
    $("browse-next").disabled = true;
    $("browse-table-wrap").hidden = true;
    $("browse-empty").hidden = true;
    setStatus($("browse-status"), "Loading records…");
    $("browse-collection-info").textContent =
      `${collectionName} · ${$("browse-collection").selectedOptions[0]?.dataset.dbType || "database type unavailable"}`;
    try {
      const query = new URLSearchParams({ limit: String(BROWSE_PAGE_SIZE), offset: String(offset) });
      const result = await api(
        `/v1/client/projects/${encodeURIComponent(projectId)}/browse/${encodeURIComponent(collectionName)}?${query}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!Array.isArray(result.results)) throw new Error("The server returned an invalid records response.");
      browseRecords = result.results;
      renderBrowseRecords();
      $("browse-page-label").textContent = `Page ${Math.floor(offset / BROWSE_PAGE_SIZE) + 1}`;
      $("browse-previous").disabled = offset === 0;
      $("browse-next").disabled = browseRecords.length < BROWSE_PAGE_SIZE;
      if (offset + BROWSE_PAGE_SIZE > 1000000) $("browse-next").disabled = true;
      setStatus($("browse-status"), "");
    } catch (error) {
      browseRecords = [];
      $("browse-head").replaceChildren();
      $("browse-body").replaceChildren();
      $("browse-count").textContent = "";
      $("browse-table-wrap").hidden = true;
      $("browse-empty").hidden = true;
      $("browse-search").disabled = true;
      setStatus($("browse-status"), error.message, true);
    } finally {
      $("browse-refresh").disabled = false;
    }
  }

  function setAuthMode(mode) {
    $("show-login").hidden = false;
    $("show-register").hidden = false;
    const registering = mode === "register";
    $("login-form").hidden = registering;
    $("register-form").hidden = !registering;
    $("show-login").classList.toggle("active", !registering);
    $("show-register").classList.toggle("active", registering);
    $("show-login").setAttribute("aria-selected", String(!registering));
    $("show-register").setAttribute("aria-selected", String(registering));
    setStatus(authStatus, "");
  }

  async function showDashboard(account) {
    authView.hidden = true;
    dashboard.hidden = false;
    $("account-label").textContent = `${account.displayName} (${account.email})`;
    projectsView.hidden = false;
    await loadProjects();
  }

  async function loadProjects() {
    try {
      const result = await api("/v1/client/projects");
      projects = result.projects;
      $("browse-project").innerHTML = '<option value="">Select a project</option>' +
        projects.map((project) =>
          `<option value="${esc(project.projectId)}">${esc(project.name)}</option>`,
        ).join("");
      $("project-list").innerHTML = projects.length
        ? projects.map((p) => `<button type="button" class="project-link ${p.projectId === selectedProjectId ? "active" : ""}" data-id="${esc(p.projectId)}">${esc(p.name)}<small>${esc(p.projectId)} · ${esc(p.status)}</small></button>`).join("")
        : '<p class="muted">No projects yet. Create one to get started.</p>';
      $("project-list").querySelectorAll("[data-id]").forEach((button) => {
        button.addEventListener("click", () => selectProject(button.dataset.id));
      });
      if (selectedProjectId && projects.some((p) => p.projectId === selectedProjectId)) await selectProject(selectedProjectId);
      else {
        selectedProjectId = null;
        $("browse-api-key").value = "";
        $("browse-project").value = "";
        $("browse-collection").innerHTML = '<option value="">Select a project first</option>';
        $("browse-collection").disabled = true;
        clearBrowse();
        $("project-detail").innerHTML = '<p class="muted">Select a project or create one to get started.</p>';
        $("connection-guide").hidden = true;
      }
    } catch (error) {
      setStatus(portalStatus, error.message, true);
    }
  }

  function formatUsage(usage) {
    return `<div class="stats"><p><strong>Requests:</strong> ${esc(usage.requests)}</p><p><strong>Reads/queries:</strong> ${esc(usage.queries)}</p><p><strong>Writes:</strong> ${esc(usage.inserts + usage.updates + usage.deletes)}</p><p><strong>Errors:</strong> ${esc(usage.errors)}</p><p><strong>Storage:</strong> ${esc(usage.storageBytes)} bytes</p></div>`;
  }

  async function selectProject(projectId) {
    if (selectedProjectId !== projectId) $("browse-api-key").value = "";
    selectedProjectId = projectId;
    $("browse-project").value = projectId;
    browseOffset = 0;
    $("browse-collection").innerHTML = '<option value="">Loading collections…</option>';
    $("browse-collection").disabled = true;
    clearBrowse("Loading project collections…");
    setStatus(portalStatus, "Loading project…");
    try {
      const [detail, usage, keysResult] = await Promise.all([
        api(`/v1/client/projects/${encodeURIComponent(projectId)}`),
        api(`/v1/client/projects/${encodeURIComponent(projectId)}/usage`),
        api(`/v1/client/projects/${encodeURIComponent(projectId)}/keys`),
      ]);
      const collections = detail.collections.length
        ? `<ul>${detail.collections.map((c) => `<li><code>${esc(c.collection)}</code> · ${esc(c.dbType)}</li>`).join("")}</ul>`
        : '<p class="muted">No collections yet. They are created on the first write, or with POST /v1/collections.</p>';
      $("browse-collection").innerHTML = detail.collections.length
        ? '<option value="">Select a collection</option>' + detail.collections.map((collection) =>
          `<option value="${esc(collection.collection)}" data-db-type="${esc(collection.dbType)}">${esc(collection.collection)} (${esc(collection.dbType)})</option>`,
        ).join("")
        : '<option value="">No collections available</option>';
      $("browse-collection").disabled = detail.collections.length === 0;
      $("browse-collection-info").textContent = detail.collections.length
        ? "Select a collection and enter a project API key with data:read."
        : "This project has no collections to browse.";
      const keys = keysResult.keys.length ? keysResult.keys.map((key) => `
        <div class="key-row">
          <div class="key-meta"><code>${esc(key.prefix)}</code><small>${esc(key.label || "API key")} · ${esc(key.status)} · ${esc(key.scopes.join(", "))}</small></div>
          ${key.status === "active" ? `<button type="button" class="danger revoke-key" data-key="${esc(key.keyId)}">Revoke</button>` : ""}
        </div>`).join("") : '<p class="muted">No API keys found.</p>';
      $("project-detail").innerHTML = `
        <h2>${esc(detail.name)}</h2>
        <p><strong>Project ID:</strong> <code>${esc(detail.projectId)}</code> · <strong>Status:</strong> ${esc(detail.status)}</p>
        <p><strong>Created:</strong> ${esc(new Date(detail.createdAt).toLocaleString())}</p>
        <h3>Collections</h3>${collections}
        <h3>Usage and quotas</h3>${formatUsage(usage.usage)}
        <p class="muted">Limits: ${esc(JSON.stringify(usage.quotas))}</p>
        <h3>API keys</h3><div class="key-list">${keys}</div>
        <form id="new-key-form" class="compact-form">
          <h3>Create an API key</h3>
          <label for="key-label">Label</label><input id="key-label" maxlength="60" placeholder="Backend service" />
          <fieldset><legend>Permissions</legend>
            <label class="check"><input type="checkbox" name="key-scope" value="data:read" checked /> Read data</label>
            <label class="check"><input type="checkbox" name="key-scope" value="data:write" /> Write data</label>
            <label class="check"><input type="checkbox" name="key-scope" value="collections:manage" /> Manage collections</label>
            <label class="check"><input type="checkbox" name="key-scope" value="usage:read" /> Read usage</label>
            <label class="check"><input type="checkbox" name="key-scope" value="import" /> Import data (also requires Write data)</label>
          </fieldset>
          <button type="submit">Create API key</button>
        </form>`;
      $("new-key-form").addEventListener("submit", createKey);
      $("project-detail").querySelectorAll(".revoke-key").forEach((button) => {
        button.addEventListener("click", () => revokeKey(button.dataset.key));
      });
      $("connection-guide").hidden = false;
      const base = `${location.origin}/v1`;
      $("api-base").textContent = base;
      $("guide-project-id").textContent = detail.projectId;
      $("read-example").textContent = `curl -H "Authorization: Bearer $MAESTRO_API_KEY" \\\n  "${base}/data/items"\n\ncurl -H "Authorization: Bearer $MAESTRO_API_KEY" \\\n  "${base}/data/items/RECORD_ID"`;
      $("get-example").textContent = `curl -H "Authorization: Bearer $MAESTRO_API_KEY" \\\n  "${base}/collections"`;
      $("post-example").textContent = `curl -X POST "${base}/data" \\\n  -H "Authorization: Bearer $MAESTRO_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"collection":"items","data":{"name":"Example"}}'`;
      $("project-list").querySelectorAll("[data-id]").forEach((button) => {
        button.classList.toggle("active", button.dataset.id === selectedProjectId);
      });
      setStatus(portalStatus, "");
    } catch (error) {
      setStatus(portalStatus, error.message, true);
    }
  }

  function showSecret(key, title) {
    $("secret-title").textContent = title;
    $("secret-value").textContent = key;
    setStatus($("secret-status"), "");
    $("secret-dialog").showModal();
  }

  function clearSecret() {
    $("secret-value").textContent = "";
    $("secret-dialog").close();
  }

  async function createKey(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.submitting === "true") return;
    const scopes = [...document.querySelectorAll('input[name="key-scope"]:checked')].map((input) => input.value);
    if (!scopes.length) return setStatus(portalStatus, "Select at least one permission.", true);
    form.dataset.submitting = "true";
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(portalStatus, "Creating API key…");
    try {
      const key = await api(`/v1/client/projects/${encodeURIComponent(selectedProjectId)}/keys`, {
        method: "POST", body: { label: $("key-label").value.trim(), scopes },
      });
      showSecret(key.apiKey, "New API key");
      await selectProject(selectedProjectId);
      setStatus(portalStatus, "API key created. Its secret is shown once.");
    } catch (error) { setStatus(portalStatus, error.message, true); }
    finally {
      delete form.dataset.submitting;
      button.disabled = false;
    }
  }

  async function revokeKey(keyId) {
    if (!confirm("Revoke this API key? Applications using it will no longer authenticate.")) return;
    try {
      await api(`/v1/client/projects/${encodeURIComponent(selectedProjectId)}/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
      setStatus(portalStatus, "API key revoked.");
      await selectProject(selectedProjectId);
    } catch (error) { setStatus(portalStatus, error.message, true); }
  }

  $("show-login").addEventListener("click", () => setAuthMode("login"));
  $("show-register").addEventListener("click", () => setAuthMode("register"));
  $("browse-project").addEventListener("change", () => {
    const projectId = $("browse-project").value;
    if (projectId) selectProject(projectId);
    else {
      selectedProjectId = null;
      $("browse-collection").innerHTML = '<option value="">Select a project first</option>';
      $("browse-collection").disabled = true;
      clearBrowse();
      $("project-detail").innerHTML = '<p class="muted">Select a project or create one to get started.</p>';
    }
  });
  $("browse-collection").addEventListener("change", () => {
    browseOffset = 0;
    clearBrowse($("browse-collection").value
      ? "Collection selected. Enter a project API key with data:read, then browse."
      : "Select a collection.");
  });
  $("browse-api-key").addEventListener("input", () => {
    $("browse-refresh").disabled = !$("browse-collection").value;
  });
  $("browse-refresh").addEventListener("click", () => loadBrowse(0));
  $("browse-search").addEventListener("input", renderBrowseRecords);
  $("browse-previous").addEventListener("click", () =>
    loadBrowse(Math.max(0, browseOffset - BROWSE_PAGE_SIZE)));
  $("browse-next").addEventListener("click", () =>
    loadBrowse(Math.min(1000000, browseOffset + BROWSE_PAGE_SIZE)));
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.submitting === "true") return;
    form.dataset.submitting = "true";
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(authStatus, "Signing in…");
    try {
      const result = await api("/v1/client/auth/login", {
        method: "POST",
        body: { email: $("login-email").value, password: $("login-password").value },
      });
      await showDashboard(result.account);
    } catch (error) { setStatus(authStatus, error.message, true); }
    finally {
      delete form.dataset.submitting;
      button.disabled = false;
    }
  });
  $("register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.submitting === "true") return;
    form.dataset.submitting = "true";
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(authStatus, "Creating account…");
    try {
      const result = await api("/v1/client/auth/register", {
        method: "POST",
        body: {
          displayName: $("register-name").value,
          email: $("register-email").value,
          password: $("register-password").value,
        },
      });
      setAuthMode("login");
      $("login-email").value = result.account.email;
      setStatus(authStatus, result.message || "Account created. Sign in to access the Client Portal.");
    } catch (error) { setStatus(authStatus, error.message, true); }
    finally {
      delete form.dataset.submitting;
      button.disabled = false;
    }
  });
  $("project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.submitting === "true") return;
    const scopes = [...document.querySelectorAll('input[name="project-scope"]:checked')].map((input) => input.value);
    if (!scopes.length) return setStatus(portalStatus, "Select at least one initial API-key permission.", true);
    const button = form.querySelector('button[type="submit"]');
    const body = { name: $("project-name").value.trim(), scopes };
    const fingerprint = JSON.stringify(body);
    if (fingerprint !== projectSubmissionFingerprint) {
      projectSubmissionKey = window.crypto.randomUUID();
      projectSubmissionFingerprint = fingerprint;
    }
    form.dataset.submitting = "true";
    button.disabled = true;
    setStatus(portalStatus, "Creating project…");
    try {
      const project = await api("/v1/client/projects", {
        method: "POST",
        headers: { "Idempotency-Key": projectSubmissionKey },
        body,
      });
      projectSubmissionKey = null;
      projectSubmissionFingerprint = null;
      if (project.replayed) {
        selectedProjectId = project.projectId;
        await loadProjects();
        setStatus(portalStatus, project.note || "This project request was already completed. Its API key cannot be shown again; create another key if needed.");
        return;
      }
      $("project-name").value = "";
      $("browse-api-key").value = "";
      selectedProjectId = project.projectId;
      showSecret(project.apiKey, `API key for ${project.name}`);
      await loadProjects();
      setStatus(portalStatus, "Project created. Its first API key is shown once.");
    } catch (error) { setStatus(portalStatus, error.message, true); }
    finally {
      delete form.dataset.submitting;
      button.disabled = false;
    }
  });
  $("sign-out").addEventListener("click", async () => {
    const button = $("sign-out");
    if (button.disabled) return;
    button.disabled = true;
    setStatus(portalStatus, "Signing out…");
    try {
      await api("/v1/client/auth/logout", { method: "POST", body: {} });
      dashboard.hidden = true;
      authView.hidden = false;
      selectedProjectId = null;
      projects = [];
      clearSecret();
      $("browse-api-key").value = "";
      $("browse-project").innerHTML = '<option value="">Select a project</option>';
      $("browse-collection").innerHTML = '<option value="">Select a project first</option>';
      $("browse-collection").disabled = true;
      clearBrowse();
      $("project-list").innerHTML = '<p class="muted">No projects loaded.</p>';
      setStatus(authStatus, "You have signed out.");
    } catch (error) {
      if (error.status === 401) {
        dashboard.hidden = true;
        authView.hidden = false;
        $("browse-api-key").value = "";
        clearBrowse();
        setStatus(authStatus, "Your session has ended. Please sign in again.");
      } else {
        setStatus(portalStatus, error.message, true);
      }
    } finally {
      button.disabled = false;
    }
  });
  $("copy-secret").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("secret-value").textContent);
      setStatus($("secret-status"), "Copied. Store it in a secure location.");
    } catch {
      setStatus($("secret-status"), "Copy was blocked by the browser. Select and copy the key manually.", true);
    }
  });
  $("close-secret").addEventListener("click", clearSecret);

  api("/v1/client/auth/me")
    .then((result) => showDashboard(result.account))
    .catch((error) => {
      authView.hidden = false;
      dashboard.hidden = true;
      if (error.status !== 401) setStatus(authStatus, error.message, true);
    });
})();
