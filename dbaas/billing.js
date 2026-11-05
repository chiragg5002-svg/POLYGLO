const PDFDocument = require("pdfkit");

const MICRO_UNITS = 1000000n;
const BYTES_PER_GB = 1000000000n;

function quantityMicros(value) {
  const text = String(value);
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text)) throw new Error("Usage quantity must be a non-negative decimal with at most six places.");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * MICRO_UNITS + BigInt(fraction.padEnd(6, "0"));
}

function chargePaise(quantity, ratePaise, divisor = 1n) {
  const rate = BigInt(ratePaise);
  const unit = BigInt(divisor);
  if (rate < 0n || unit < 1n) throw new Error("Invalid billing rate or unit.");
  const numerator = quantityMicros(quantity) * rate;
  const denominator = MICRO_UNITS * unit;
  return (numerator + denominator / 2n) / denominator;
}

function formatInrPaise(value) {
  const paise = BigInt(value);
  const sign = paise < 0n ? "-" : "";
  const absolute = paise < 0n ? -paise : paise;
  const rupees = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${sign}₹${rupees.toLocaleString("en-IN")}.${fraction}`;
}

function formatPdfInr(value) {
  return formatInrPaise(value).replace(/^₹/, "INR ");
}

function inclusiveDays(start, end) {
  const from = Date.parse(`${start}T00:00:00.000Z`);
  const to = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error("Billing period dates are invalid.");
  return Math.floor((to - from) / 86400000) + 1;
}

function formatMicros(value) {
  const micros = BigInt(value);
  return `${micros / MICRO_UNITS}.${String(micros % MICRO_UNITS).padStart(6, "0")}`;
}

function bytesToGb(bytes) {
  const value = BigInt(bytes);
  return formatMicros((value * MICRO_UNITS + BYTES_PER_GB / 2n) / BYTES_PER_GB);
}

function daysInMonth(date) {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function billedMonths(period) {
  const match = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/.exec(period);
  if (!match) throw new Error("Billing period label must contain two ISO dates.");
  const [start, end] = match.slice(1);
  inclusiveDays(start, end);
  let cursor = Date.parse(`${start}T00:00:00.000Z`);
  const final = Date.parse(`${end}T00:00:00.000Z`);
  let quantity = 0n;
  while (cursor <= final) {
    const date = new Date(cursor);
    const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
    const segmentEnd = Math.min(monthEnd, final);
    const days = BigInt(Math.floor((segmentEnd - cursor) / 86400000) + 1);
    const monthDays = BigInt(daysInMonth(startOfUtcMonth(date)));
    quantity += (days * MICRO_UNITS + monthDays / 2n) / monthDays;
    cursor = segmentEnd + 86400000;
  }
  return formatMicros(quantity);
}

function startOfUtcMonth(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function aggregateUsageRows({ projects, daily, periodStart, periodEnd }) {
  const expectedRows = projects.reduce((total, project) => {
    const projectStart = typeof project === "string" ? periodStart : String(project.created_at).slice(0, 10);
    if (projectStart > periodEnd) return total;
    return total + inclusiveDays(projectStart < periodStart ? periodStart : projectStart, periodEnd);
  }, 0);
  const complete = projects.length === 0 || daily.length === expectedRows;
  let requests = 0n;
  let bytes = 0n;
  const storageByteDaysByMonth = new Map();
  let transferAvailable = complete;
  let storageAvailable = complete;
  for (const row of daily) {
    requests += BigInt(row.api_requests || 0);
    if (row.transfer_available === false || row.outbound_bytes === null || row.outbound_bytes === undefined) {
      transferAvailable = false;
    } else {
      bytes += BigInt(row.outbound_bytes);
    }
    if (row.storage_available !== true || row.storage_bytes === null || row.storage_bytes === undefined) {
      storageAvailable = false;
    } else {
      const date = String(row.usage_date || periodStart).slice(0, 10);
      const month = date.slice(0, 7);
      storageByteDaysByMonth.set(month, (storageByteDaysByMonth.get(month) || 0n) + BigInt(row.storage_bytes));
    }
  }
  const storageMicros = storageAvailable
    ? [...storageByteDaysByMonth].reduce((total, [month, byteDays]) => {
      const monthDays = BigInt(daysInMonth(`${month}-01`));
      return total + (byteDays * MICRO_UNITS + BYTES_PER_GB * monthDays / 2n) / (BYTES_PER_GB * monthDays);
    }, 0n)
    : null;
  return {
    apiRequests: requests.toString(),
    outboundBytes: transferAvailable ? bytes.toString() : null,
    storageGbMonth: storageMicros === null ? null : formatMicros(storageMicros),
    transferAvailable,
    storageAvailable,
    expectedStorageSnapshots: expectedRows,
    actualDailyRows: daily.length,
  };
}

function buildUsageLines({ apiRequests, outboundBytes, storageGbMonth }, plan, period) {
  const apiUnits = Number(plan.requests_per_unit);
  const storageRate = BigInt(plan.storage_paise_per_gb_month);
  const apiRate = BigInt(plan.request_unit_paise);
  const transferRate = BigInt(plan.transfer_paise_per_gb);
  if (!Number.isSafeInteger(apiUnits) || apiUnits < 1) throw new Error("Configured request billing unit is invalid.");
  const requestQty = String(apiRequests);
  const transferGb = bytesToGb(outboundBytes);
  const storageQty = Number(storageGbMonth).toFixed(6);
  const lines = [];
  const monthlyFee = BigInt(plan.monthly_fee_paise || 0);
  if (monthlyFee > 0n) {
    const months = billedMonths(period);
    lines.push({
      description: "Plan subscription",
      service: plan.name,
      quantity: months,
      unit: "month",
      unitPricePaise: monthlyFee.toString(),
      usagePeriod: period,
      amountPaise: chargePaise(months, monthlyFee).toString(),
    });
  }
  lines.push(
    {
      description: "Database storage",
      service: "Database storage",
      quantity: storageQty,
      unit: "GB-month",
      unitPricePaise: storageRate.toString(),
      usagePeriod: period,
      amountPaise: chargePaise(storageQty, storageRate).toString(),
    },
    {
      description: "Billable API requests",
      service: "MAESTRO API",
      quantity: requestQty,
      unit: "requests",
      unitPricePaise: apiRate.toString(),
      unitPriceLabel: `${formatPdfInr(apiRate)} per ${apiUnits.toLocaleString("en-IN")} requests`,
      usagePeriod: period,
      amountPaise: chargePaise(requestQty, apiRate, BigInt(apiUnits)).toString(),
    },
    {
      description: "Outbound data transfer",
      service: "Outbound transfer",
      quantity: transferGb,
      unit: "GB",
      unitPricePaise: transferRate.toString(),
      usagePeriod: period,
      amountPaise: chargePaise(transferGb, transferRate).toString(),
    },
  );
  return {
    lines,
    subtotalPaise: lines.reduce((total, line) => total + BigInt(line.amountPaise), 0n).toString(),
  };
}

async function renderInvoicePdf(invoice) {
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const blue = "#123C87";
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const drawHeader = () => {
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(22).text("MAESTRO DBaaS", { continued: true });
    doc.fillColor("#334155").fontSize(18).text("  INVOICE", { align: "right" });
    doc.moveDown(0.4);
    doc.fillColor("#9A3412").fontSize(9).text("DEMO — NOT A TAX INVOICE");
    doc.moveDown(0.8);
  };
  const drawTableHeader = () => {
    doc.fillColor(blue).font("Helvetica-Bold").fontSize(9);
    doc.text("Description", doc.page.margins.left, doc.y, { width: 180 });
    doc.text("Qty / Unit", 230, doc.y, { width: 100 });
    doc.text("Unit price", 330, doc.y, { width: 95 });
    doc.text("Amount", 430, doc.y, { width: 115, align: "right" });
    doc.moveDown(0.4);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#CBD5E1").stroke();
    doc.moveDown(0.5);
    doc.fillColor("#172033").font("Helvetica").fontSize(9);
  };
  drawHeader();
  doc.fontSize(10).fillColor("#172033");
  doc.text(`Invoice number: ${invoice.invoiceNumber}`);
  doc.text(`Status: ${invoice.status.toUpperCase()}   Currency: INR`);
  doc.text(`Issue date: ${invoice.issuedAt ? new Date(invoice.issuedAt).toISOString().slice(0, 10) : "Draft"}`);
  doc.text(`Billing period: ${invoice.periodStart} to ${invoice.periodEnd}`);
  doc.text(`Due date: ${invoice.dueDate || "Not issued"}`);
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").text("Bill to");
  doc.font("Helvetica").text(invoice.clientName);
  doc.text(invoice.clientEmail);
  if (invoice.clientId) doc.text(`Client account: ${invoice.clientId}`);
  if (invoice.billingAddress) doc.text(invoice.billingAddress);
  if (invoice.purchaseOrder) doc.text(`Customer reference: ${invoice.purchaseOrder}`);
  doc.moveDown(1);
  drawTableHeader();
  for (const line of invoice.items) {
    const description = `${line.description}\n${line.service} · ${line.usagePeriod}`;
    const height = Math.max(doc.heightOfString(description, { width: 180 }), 28) + 8;
    if (doc.y + height > doc.page.height - 115) {
      doc.addPage();
      drawHeader();
      drawTableHeader();
    }
    const y = doc.y;
    doc.text(description, doc.page.margins.left, y, { width: 180 });
    doc.text(`${line.quantity}\n${line.unit}`, 230, y, { width: 95 });
    doc.text(line.unitPriceLabel || formatPdfInr(line.unitPricePaise), 330, y, { width: 95 });
    doc.text(formatPdfInr(line.amountPaise), 430, y, { width: 115, align: "right" });
    doc.y = y + height;
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#E2E8F0").stroke();
    doc.moveDown(0.4);
  }
  if (doc.y + 100 > doc.page.height - 60) {
    doc.addPage();
    drawHeader();
  }
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(10);
  doc.text(`Subtotal: ${formatPdfInr(invoice.subtotalPaise)}`, { align: "right" });
  doc.text(`Tax: ${formatPdfInr(invoice.taxPaise || 0)} (not configured)`, { align: "right" });
  doc.text(`Payments received: ${formatPdfInr(invoice.paidPaise || 0)}`, { align: "right" });
  doc.fontSize(13).fillColor(blue).text(`Amount due: ${formatPdfInr(invoice.amountDuePaise)}`, { align: "right" });
  doc.fillColor("#475569").font("Helvetica").fontSize(8).text(
    "This demonstration invoice is not a tax invoice. No tax, provider registration, or payment details are asserted.",
    doc.page.margins.left, doc.page.height - 68, { width: pageWidth, align: "center" });
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.fillColor("#64748B").fontSize(8).text(
      `Page ${i + 1} of ${range.count}`,
      doc.page.margins.left, doc.page.height - 48, { width: pageWidth, align: "right" });
  }
  doc.end();
  return complete;
}

module.exports = {
  BYTES_PER_GB,
  inclusiveDays,
  quantityMicros,
  billedMonths,
  bytesToGb,
  aggregateUsageRows,
  chargePaise,
  formatInrPaise,
  formatPdfInr,
  buildUsageLines,
  renderInvoicePdf,
};
