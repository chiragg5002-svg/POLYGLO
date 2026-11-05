/*
 * Minimal Prometheus-text metrics registry (no dependency). Counters,
 * gauges (pull-based callbacks) and one latency histogram.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

class Metrics {
  constructor() {
    this.counters = new Map();
    this.hist = new Map();
    this.gauges = new Map();
    this.startedAt = Date.now();
  }
  inc(name, labels = {}, n = 1) {
    const k = `${name}${fmtLabels(labels)}`;
    this.counters.set(k, (this.counters.get(k) || 0) + n);
  }
  observe(name, labels, seconds) {
    const k = `${name}${fmtLabels(labels)}`;
    let h = this.hist.get(k);
    if (!h) { h = { name, labels, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.hist.set(k, h); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i] += 1; });
    h.sum += seconds; h.count += 1;
  }
  gauge(name, fn) { this.gauges.set(name, fn); }
  render() {
    const out = [];
    for (const [k, v] of this.counters) out.push(`${k} ${v}`);
    for (const h of this.hist.values()) {
      BUCKETS.forEach((b, i) => out.push(`${h.name}_bucket${fmtLabels({ ...h.labels, le: b })} ${h.buckets[i]}`));
      out.push(`${h.name}_bucket${fmtLabels({ ...h.labels, le: "+Inf" })} ${h.count}`);
      out.push(`${h.name}_sum${fmtLabels(h.labels)} ${h.sum.toFixed(6)}`);
      out.push(`${h.name}_count${fmtLabels(h.labels)} ${h.count}`);
    }
    for (const [name, fn] of this.gauges) {
      try {
        const v = fn();
        if (v && typeof v === "object") for (const [lab, val] of Object.entries(v)) out.push(`${name}${fmtLabels({ kind: lab })} ${Number(val) || 0}`);
        else out.push(`${name} ${Number(v) || 0}`);
      } catch (e) { /* skip broken gauge */ }
    }
    const m = process.memoryUsage();
    out.push(`maestro_process_resident_memory_bytes ${m.rss}`, `maestro_process_heap_used_bytes ${m.heapUsed}`,
      `maestro_process_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    return `${out.join("\n")}\n`;
  }
}

function fmtLabels(labels) {
  const e = Object.entries(labels || {});
  if (!e.length) return "";
  return `{${e.map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, "_")}"`).join(",")}}`;
}

module.exports = { Metrics, metrics: new Metrics() };
