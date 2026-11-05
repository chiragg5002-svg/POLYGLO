(() => {
  const $ = (id) => document.getElementById(id);
  const page = $("billing-page");
  const authRequired = $("billing-auth-required");
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  async function api(path, options = {}) {
    const response = await fetch(path, {
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

  function setStatus(message, error = false) {
    $("billing-status").textContent = message || "";
    $("billing-status").classList.toggle("error", error);
  }

  function formatPaise(value) {
    if (value === null || value === undefined) return "Unavailable";
    const paise = BigInt(value);
    const sign = paise < 0n ? "-" : "";
    const absolute = paise < 0n ? -paise : paise;
    return `${sign}₹${(absolute / 100n).toLocaleString("en-IN")}.${String(absolute % 100n).padStart(2, "0")}`;
  }

  function renderInvoices(invoices) {
    const payable = invoices.filter((invoice) => ["issued", "partially_paid", "overdue"].includes(invoice.status));
    const outstanding = payable.reduce((total, invoice) => total + BigInt(invoice.balanceDuePaise || 0), 0n);
    $("billing-payment-summary").textContent = payable.length
      ? `${payable.length} issued invoice(s) · outstanding ${formatPaise(outstanding)}`
      : invoices.some((invoice) => invoice.status === "paid")
        ? "All issued invoices are paid."
        : "No issued invoice is currently due.";
    $("billing-invoices").innerHTML = invoices.length ? invoices.map((invoice) => `
      <article class="invoice-card">
        <div class="billing-heading">
          <strong>${esc(invoice.invoiceNumber)} · ${esc(invoice.status)}</strong>
          ${["issued", "partially_paid", "paid", "overdue"].includes(invoice.status)
            ? `<a href="/v1/client/billing/invoices/${encodeURIComponent(invoice.invoiceId)}/pdf">Download PDF</a>`
            : '<span class="muted">PDF available after invoice issuance</span>'}
        </div>
        <p class="muted">${esc(invoice.periodStart)} to ${esc(invoice.periodEnd)} · ${invoice.demo ? "DEMO — NOT A TAX INVOICE" : "INR invoice"}</p>
        <div class="invoice-table-wrap"><table class="invoice-items"><thead><tr>
          <th>Description</th><th>Quantity</th><th>Unit price</th><th>Amount</th>
        </tr></thead><tbody>${(invoice.items || []).map((item) => `<tr>
          <td>${esc(item.description)}<br><small>${esc(item.service)} · ${esc(item.usagePeriod)}</small></td>
          <td>${esc(item.quantity)} ${esc(item.unit)}</td>
          <td>${esc(item.unitPriceLabel || formatPaise(item.unitPricePaise))}</td>
          <td>${formatPaise(item.amountPaise)}</td>
        </tr>`).join("")}</tbody></table></div>
        <p><strong>Invoice total: ${formatPaise(invoice.amountDuePaise)} · Outstanding: ${formatPaise(invoice.balanceDuePaise)}</strong></p>
      </article>`).join("") : '<p class="muted">No invoices have been issued.</p>';
  }

  async function loadBilling() {
    setStatus("Loading current usage and invoices…");
    try {
      const [usageResult, invoiceResult, paymentResult, plansResult] = await Promise.all([
        api("/v1/client/billing/usage"),
        api("/v1/client/billing/invoices"),
        api("/v1/client/billing/payments"),
        api("/v1/client/billing/plans"),
      ]);
      const usage = usageResult.usage || {};
      const estimate = usageResult.estimatedCharges;
      const subscription = usageResult.subscription;
      const plan = usageResult.plan;
      $("billing-period").textContent = usageResult.period
        ? `UTC billing period ${usageResult.period.start} to ${usageResult.period.end}; measured through ${usageResult.period.through}.`
        : "Usage estimates use the current UTC billing period.";
      $("billing-current-plan").innerHTML = plan
        ? `<div class="billing-current-plan-main"><strong>${esc(plan.name)}</strong>
            <span>${plan.pricingConfigured ? `${formatPaise(plan.monthlyFeePaise)} / month` : "Pricing not configured"}</span></div>
          <p class="muted">Billing period: ${esc(subscription && subscription.periodStart || usageResult.period.start)}
            to ${esc(subscription && subscription.periodEnd || usageResult.period.end)} · Status: ${esc(subscription && subscription.status || "active")}</p>
          ${usageResult.pendingPlan && subscription && subscription.pendingEffectiveAt
            ? `<p class="notice">Plan change to ${esc(usageResult.pendingPlan.name)} is scheduled for ${esc(subscription.pendingEffectiveAt)}.</p>`
            : ""}`
        : '<p class="warning">No billing plan is assigned. Contact support before usage is invoiced.</p>';

      const plans = plansResult.plans || [];
      $("billing-plan-catalog").innerHTML = plans.length ? plans.map((candidate) => {
        const current = candidate.planId === (subscription && subscription.planId);
        const pending = candidate.planId === (subscription && subscription.pendingPlanId);
        const canSchedule = candidate.available && candidate.pricingConfigured && !current && !pending;
        return `<article class="billing-plan-card ${current ? "current" : ""}">
          <h4>${esc(candidate.name)}${current ? " · Current" : pending ? " · Scheduled" : ""}</h4>
          <p class="plan-price">${candidate.pricingConfigured ? `${formatPaise(candidate.monthlyFeePaise)} / month` : "Pricing not configured"}</p>
          ${candidate.pricingConfigured ? `<ul>
            <li>Storage: ${formatPaise(candidate.storagePaisePerGbMonth)} / GB-month</li>
            <li>Requests: ${formatPaise(candidate.requestUnitPaise)} per ${esc(candidate.requestsPerUnit)} requests</li>
            <li>Transfer: ${formatPaise(candidate.transferPaisePerGb)} / GB</li>
          </ul>` : ""}
          ${canSchedule
            ? `<button type="button" data-plan-id="${esc(candidate.planId)}">Schedule next-period change</button>`
            : `<button type="button" disabled>${current ? "Current plan" : pending ? "Change scheduled" : "Unavailable"}</button>`}
        </article>`;
      }).join("") : '<p class="muted">No plans are available.</p>';

      const storage = usage.storageGbMonth === null ? "Unavailable" : `${esc(usage.storageGbMonth)} GB-month`;
      const transfer = usage.outboundBytes === null ? "Unavailable" : `${(Number(usage.outboundBytes) / 1e9).toFixed(6)} GB`;
      $("billing-usage").innerHTML = estimate ? `
        <div class="billing-stats">
          <p><strong>Storage</strong><br>${storage}</p>
          <p><strong>Billable API requests</strong><br>${esc(usage.apiRequests || "0")}</p>
          <p><strong>Outbound transfer</strong><br>${transfer}</p>
          <p><strong>Plan fee estimate</strong><br>${formatPaise(estimate.monthlyFeePaise)}</p>
          <p><strong>Estimated storage</strong><br>${formatPaise(estimate.storagePaise)}</p>
          <p><strong>Estimated API</strong><br>${formatPaise(estimate.apiPaise)}</p>
          <p><strong>Estimated transfer</strong><br>${formatPaise(estimate.transferPaise)}</p>
          <p><strong>Estimated total</strong><br>${formatPaise(estimate.totalPaise)}</p>
        </div>
        <p class="muted">${estimate.complete
          ? "Estimate only; final charges are determined from reconciled usage."
          : "Estimate is incomplete because a required measurement is unavailable. No unsupported final charge can be issued."}</p>`
        : '<p class="muted">Plan pricing is not configured; no charge estimate is available.</p>';

      const invoices = invoiceResult.invoices || [];
      renderInvoices(invoices);
      const payments = paymentResult.payments || [];
      $("billing-payments").innerHTML = payments.length
        ? `<ul>${payments.map((payment) => `<li>${esc(payment.invoiceNumber)} · ${formatPaise(payment.amountPaise)} · ${esc(payment.reference)} · ${esc(payment.recordedAt)}</li>`).join("")}</ul>`
        : '<p class="muted">No payment records.</p>';
      setStatus("");
    } catch (error) {
      setStatus(error.message, true);
      if (error.status === 401) {
        page.hidden = true;
        authRequired.hidden = false;
      }
    }
  }

  $("billing-plan-catalog").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-plan-id]");
    if (!button) return;
    button.disabled = true;
    setStatus("Scheduling plan change…");
    try {
      const result = await api("/v1/client/billing/subscription", {
        method: "PUT",
        body: { planId: button.dataset.planId },
      });
      setStatus(result.message || "Plan change scheduled.");
      await loadBilling();
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $("billing-refresh").addEventListener("click", loadBilling);
  $("billing-sign-out").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api("/v1/client/auth/logout", { method: "POST", body: {} });
      window.location.assign("/client");
    } catch (error) {
      if (error.status === 401) {
        window.location.assign("/client");
        return;
      }
      setStatus(error.message, true);
      event.currentTarget.disabled = false;
    }
  });

  api("/v1/client/auth/me")
    .then((result) => {
      $("billing-account").textContent = `${result.account.displayName} (${result.account.email})`;
      authRequired.hidden = true;
      page.hidden = false;
      return loadBilling();
    })
    .catch((error) => {
      page.hidden = true;
      authRequired.hidden = false;
      authRequired.querySelector("p").textContent = error.status === 401
        ? "Your client session is missing or expired. Sign in to view your private billing information."
        : error.message;
    });
})();
