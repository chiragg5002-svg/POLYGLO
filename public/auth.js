/*
 * Adds the operator token only when the dashboard explicitly calls this
 * helper for an operator-only route. Client data requests keep their own
 * project-key authorization and never inherit the operator credential.
 */
(function () {
  const KEY = "maestro_admin_token";
  const operatorPath = (pathname, method) => {
    if (/^\/(?:database|import|profile|partition|analysis|metadata|routing|connections|metrics)(?:\/|$)/.test(pathname) ||
        /^\/v1\/(?:projects|audit|query)(?:\/|$)/.test(pathname)) {
      return true;
    }
    if (method === "GET" && /^\/v1\/billing\/(?:clients|plans|usage|invoices|audit|export\.csv)$/.test(pathname)) {
      return true;
    }
    if (method === "PUT" && /^\/v1\/billing\/plans\/[^/]+$/.test(pathname)) {
      return true;
    }
    if (method === "POST" && /^\/v1\/billing\/(?:storage-snapshots|reconcile|payments|invoices\/drafts|invoices\/[^/]+\/(?:review|issue|void))$/.test(pathname)) {
      return true;
    }
    return false;
  };

  window.maestroOperatorFetch = function (input, init = {}) {
    const requestUrl = typeof input === "string" ? input : input.url;
    const url = new URL(requestUrl, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("Operator credentials may only be sent to this origin.");
    }
    const requestMethod = (init.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    if (!operatorPath(url.pathname, requestMethod)) {
      throw new Error("This is not an operator-only dashboard route.");
    }

    const requestHeaders = typeof input !== "string" ? input.headers : undefined;
    const headers = new Headers(init.headers || requestHeaders || {});
    const token = window.sessionStorage.getItem(KEY);
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return window.fetch(input, Object.assign({}, init, { headers }));
  };
})();
