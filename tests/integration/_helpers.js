const net = require('net');

// A quick, short-timeout "is anything listening here" check — not a
// protocol handshake, just enough to tell whether the real-service
// tests below should attempt to run. Used because none of Postgres/
// Mongo/Redis expose a friendlier zero-dependency probe than "can we
// open a TCP socket".
function isPortOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.unref();
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// Elasticsearch needs an actual HTTP response (a bare open port isn't
// enough to tell it apart from "port in use by something else" during
// its own slow startup), so this hits its health endpoint directly.
async function isHttpReachable(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok || response.status < 500;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Prints one clear, consistent line explaining why a whole real-
// service suite is soft-skipping, so `npm test`'s output makes it
// obvious these didn't silently "pass" against nothing.
function announceSkip(serviceName, howToStart) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[real-services] ${serviceName} is not reachable in this environment — skipping its integration tests.\n` +
      `[real-services] Start it with: ${howToStart}\n`,
  );
}

module.exports = { isPortOpen, isHttpReachable, announceSkip };

// Drops a throw-away PostgreSQL database created by a test (best effort).
async function dropPgDatabase(name) {
  const { Client } = require('pg');
  const c = new Client({ host: process.env.PG_HOST || 'localhost', port: Number(process.env.PG_PORT || 5432), user: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || '', database: 'postgres' });
  try {
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${String(name).replace(/"/g, '')}" WITH (FORCE)`);
  } catch (e) { /* nothing to clean */ } finally { await c.end().catch(() => {}); }
}
module.exports.dropPgDatabase = dropPgDatabase;
