// No jest.mock() — a real local Ollama instance (never a cloud LLM
// API — see gemini-service.js, which despite its filename only ever
// calls 127.0.0.1:11434 over plain HTTP). Soft-skips if nothing is
// listening at OLLAMA_HOST:OLLAMA_PORT.
const request = require('supertest');
const { isPortOpen, announceSkip } = require('./_helpers');

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);

let available = false;
let app;

beforeAll(async () => {
  available = await isPortOpen(OLLAMA_HOST, OLLAMA_PORT);
  if (available) {
    app = require('../../server');
  } else {
    announceSkip(
      'Ollama',
      `ollama serve  (and: ollama pull ${process.env.OLLAMA_MODEL || 'llama3.2:3b'})`,
    );
  }
});

const { liveTest } = require('../helpers/live');
const realTest = (name, fn, timeout) => liveTest(["ollama"])(name, fn, timeout);

describe('Ollama — real LLM-routing integration', () => {
  realTest('routing/recommend gets a usable answer from a real Ollama for ambiguous data', async () => {
    // Deliberately generic column names/values — no order/customer/
    // log/search keywords — so the deterministic rules in
    // routing-engine.js aren't confident enough to bypass Ollama
    // outright, and this genuinely exercises the LLM path rather than
    // short-circuiting on a rule.
    const response = await request(app).post('/routing/recommend').send({
      rows: [
        { fieldA: 'alpha', fieldB: 12, fieldC: 'x' },
        { fieldA: 'beta', fieldB: 34, fieldC: 'y' },
        { fieldA: 'gamma', fieldB: 56, fieldC: 'z' },
      ],
      originalName: 'ambiguous.csv',
    });

    expect(response.status).toBe(200);
    expect(['postgres', 'mongodb', 'elasticsearch', 'local']).toContain(response.body.target);
    expect(['rules', 'ollama', 'fallback']).toContain(response.body.source);
    expect(typeof response.body.reason).toBe('string');
    expect(response.body.reason.length).toBeGreaterThan(0);

    // Not a strict assertion (which rule fires vs. whether Ollama is
    // confident enough to be used is legitimately data/model-
    // dependent) — logged so a human can see what actually happened
    // against the real model.
    console.log(`[real-services] Ollama routing result: source=${response.body.source}, target=${response.body.target}`);
  }, 35000);

  realTest("a strongly-signaled dataset still bypasses Ollama (source: 'rules')", async () => {
    // Sanity check that the rules engine still short-circuits
    // correctly even with a real Ollama available — the safety net
    // (see routing-engine.js) shouldn't depend on Ollama being down.
    const response = await request(app).post('/routing/recommend').send({
      rows: [
        { timestamp: '2026-01-01T00:00:00Z', level: 'error', service: 'api', message: 'failed' },
        { timestamp: '2026-01-01T00:01:00Z', level: 'info', service: 'api', message: 'ok' },
      ],
      originalName: 'logs.json',
    });

    expect(response.status).toBe(200);
    expect(response.body.source).toBe('rules');
    expect(response.body.target).toBe('elasticsearch');
  }, 15000);
});
