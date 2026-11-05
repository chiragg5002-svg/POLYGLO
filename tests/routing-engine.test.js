const {
  ALLOWED_TARGETS,
  detectPattern,
  isUnsafeTarget,
  interpretOllamaResponse,
  suggestCollectionName,
  getRoutingRecommendation,
} = require('../routing-engine');

function expectShape(result) {
  expect(result).toHaveProperty('target');
  expect(result).toHaveProperty('confidence');
  expect(result).toHaveProperty('reason');
  expect(result).toHaveProperty('pattern');
  expect(result).toHaveProperty('source');
  expect(['rules', 'ollama', 'fallback']).toContain(result.source);
  expect(ALLOWED_TARGETS).toContain(result.target);
}

// ------------------------------------------------------------
// detectPattern (pure deterministic layer)
// ------------------------------------------------------------

describe('detectPattern', () => {
  test('CSV tabular data (no special signal) defaults to postgres, weak signal', () => {
    const rows = [
      { fruit: 'apple', color: 'red' },
      { fruit: 'banana', color: 'yellow' },
    ];
    const result = detectPattern({ rows, originalName: 'fruit.csv' });

    expect(result.pattern).toBe('tabular');
    expect(result.target).toBe('postgres');
    expect(result.isStrong).toBe(false);
  });

  test('customer/order data is strongly routed to postgres', () => {
    const rows = [
      { orderId: 'A1', customerId: 'C1', amount: 100 },
      { orderId: 'A2', customerId: 'C2', amount: 250 },
    ];
    const result = detectPattern({ rows, originalName: 'orders.csv' });

    expect(result.pattern).toBe('transactional');
    expect(result.target).toBe('postgres');
    expect(result.isStrong).toBe(true);
  });

  test('nested JSON is strongly routed to mongodb', () => {
    const rows = [
      { id: 1, profile: { age: 30, tags: ['a', 'b'] } },
      { id: 2, profile: { age: 40, tags: ['c'] } },
    ];
    const result = detectPattern({ rows, originalName: 'users.json' });

    expect(result.pattern).toBe('nestedDocument');
    expect(result.target).toBe('mongodb');
    expect(result.isStrong).toBe(true);
  });

  test('application logs are strongly routed to elasticsearch', () => {
    const rows = [
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', message: 'started', service: 'api' },
      { timestamp: '2024-01-01T00:01:00Z', level: 'error', message: 'failed', service: 'api' },
    ];
    const result = detectPattern({ rows, originalName: 'application_logs.json' });

    expect(result.pattern).toBe('applicationLogs');
    expect(result.target).toBe('elasticsearch');
    expect(result.isStrong).toBe(true);
  });

  test('search documents (title/content/description) are strongly routed to elasticsearch', () => {
    const rows = [
      { title: 'Getting started', content: 'Full guide...', description: 'Intro doc' },
      { title: 'Advanced usage', content: 'Deep dive...', description: 'Advanced doc' },
    ];
    const result = detectPattern({ rows, originalName: 'articles.json' });

    expect(result.pattern).toBe('fullTextSearch');
    expect(result.target).toBe('elasticsearch');
    expect(result.isStrong).toBe(true);
  });

  test('a single weak log/search field is flagged but not strong', () => {
    const rows = [{ message: 'hello' }, { message: 'world' }];
    const result = detectPattern({ rows, originalName: 'notes.csv' });

    expect(result.pattern).toBe('possibleSearchOrLogData');
    expect(result.target).toBe('elasticsearch');
    expect(result.isStrong).toBe(false);
  });

  test('a nested JSON payload that also has log fields still goes to mongodb (nested check runs first)', () => {
    const rows = [
      { timestamp: '2024-01-01', level: 'info', message: 'ok', context: { requestId: 'abc', tags: ['x'] } },
    ];
    const result = detectPattern({ rows, originalName: 'nested_logs.json' });
    expect(result.target).toBe('mongodb');
    expect(result.pattern).toBe('nestedDocument');
  });
});

// ------------------------------------------------------------
// isUnsafeTarget — the core safety net
// ------------------------------------------------------------

describe('isUnsafeTarget', () => {
  test('flags postgres as unsafe for a weak search/log signal', () => {
    const ruleSignal = { pattern: 'possibleSearchOrLogData' };
    expect(isUnsafeTarget({ ruleSignal, target: 'postgres' })).toBe(true);
  });

  test('does not flag elasticsearch or mongodb as unsafe for the same signal', () => {
    const ruleSignal = { pattern: 'possibleSearchOrLogData' };
    expect(isUnsafeTarget({ ruleSignal, target: 'elasticsearch' })).toBe(false);
    expect(isUnsafeTarget({ ruleSignal, target: 'mongodb' })).toBe(false);
  });

  test('does not flag postgres as unsafe for ordinary tabular/transactional signals', () => {
    expect(isUnsafeTarget({ ruleSignal: { pattern: 'tabular' }, target: 'postgres' })).toBe(false);
    expect(isUnsafeTarget({ ruleSignal: { pattern: 'transactional' }, target: 'postgres' })).toBe(false);
  });
});

// ------------------------------------------------------------
// interpretOllamaResponse — LLM output validation
// ------------------------------------------------------------

describe('interpretOllamaResponse', () => {
  test('accepts a well-formed, allowed target', () => {
    const result = interpretOllamaResponse('{"target":"postgres","confidence":"high","reason":"structured data"}');
    expect(result.valid).toBe(true);
    expect(result.target).toBe('postgres');
  });

  test('strips markdown fences and extracts the JSON object', () => {
    const result = interpretOllamaResponse('```json\n{"target":"mongodb","confidence":"medium","reason":"flexible schema"}\n```');
    expect(result.valid).toBe(true);
    expect(result.target).toBe('mongodb');
  });

  test('rejects a target outside the allowed list', () => {
    const result = interpretOllamaResponse('{"target":"sqlite","confidence":"high","reason":"why not"}');
    expect(result.valid).toBe(false);
  });

  test('rejects unparseable text', () => {
    const result = interpretOllamaResponse('I think you should use a database.');
    expect(result.valid).toBe(false);
  });

  test('rejects empty input', () => {
    expect(interpretOllamaResponse('').valid).toBe(false);
  });

  test('defaults an invalid confidence value to medium', () => {
    const result = interpretOllamaResponse('{"target":"postgres","confidence":"super-high","reason":"x"}');
    expect(result.valid).toBe(true);
    expect(result.confidence).toBe('medium');
  });
});

// ------------------------------------------------------------
// suggestCollectionName
// ------------------------------------------------------------

describe('suggestCollectionName', () => {
  test('derives a sanitized name from the filename', () => {
    expect(suggestCollectionName('application_logs.json')).toBe('application_logs');
    expect(suggestCollectionName('My Orders 2024.csv')).toBe('My_Orders_2024');
  });

  test('falls back to a default when no name is given', () => {
    expect(suggestCollectionName('', 'fallback_name')).toBe('fallback_name');
  });
});

// ------------------------------------------------------------
// getRoutingRecommendation — full hybrid pipeline
// ------------------------------------------------------------

describe('getRoutingRecommendation', () => {
  test('CSV tabular data with no strong rule consults Ollama and accepts a safe answer', async () => {
    const rows = [
      { fruit: 'apple', color: 'red' },
      { fruit: 'banana', color: 'yellow' },
    ];

    const callOllamaFn = jest.fn().mockResolvedValue(
      '{"target":"postgres","confidence":"medium","reason":"Flat tabular CSV data fits a relational table."}',
    );
    const buildPromptFn = jest.fn().mockReturnValue('prompt');

    const result = await getRoutingRecommendation({
      rows,
      originalName: 'fruit.csv',
      callOllamaFn,
      buildPromptFn,
    });

    expectShape(result);
    expect(callOllamaFn).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('ollama');
    expect(result.target).toBe('postgres');
  });

  test('customer/order data is decided by rules alone, without calling Ollama', async () => {
    const rows = [
      { orderId: 'A1', customerId: 'C1', amount: 100 },
      { orderId: 'A2', customerId: 'C2', amount: 250 },
    ];
    const callOllamaFn = jest.fn();

    const result = await getRoutingRecommendation({ rows, originalName: 'orders.csv', callOllamaFn });

    expectShape(result);
    expect(result.source).toBe('rules');
    expect(result.target).toBe('postgres');
    expect(result.pattern).toBe('transactional');
    expect(callOllamaFn).not.toHaveBeenCalled();
  });

  test('nested JSON is decided by rules alone, without calling Ollama', async () => {
    const rows = [{ id: 1, profile: { age: 30, tags: ['a', 'b'] } }];
    const callOllamaFn = jest.fn();

    const result = await getRoutingRecommendation({ rows, originalName: 'users.json', callOllamaFn });

    expectShape(result);
    expect(result.source).toBe('rules');
    expect(result.target).toBe('mongodb');
    expect(result.pattern).toBe('nestedDocument');
    expect(callOllamaFn).not.toHaveBeenCalled();
  });

  test('application_logs.json is recommended for elasticsearch, without calling Ollama', async () => {
    const rows = [
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', message: 'server started', service: 'api' },
      { timestamp: '2024-01-01T00:01:00Z', level: 'error', message: 'request failed', service: 'api' },
      { timestamp: '2024-01-01T00:02:00Z', level: 'info', message: 'request served', service: 'api' },
    ];
    const callOllamaFn = jest.fn();

    const result = await getRoutingRecommendation({ rows, originalName: 'application_logs.json', callOllamaFn });

    expectShape(result);
    expect(result.target).toBe('elasticsearch');
    expect(result.source).toBe('rules');
    expect(result.pattern).toBe('applicationLogs');
    expect(result.suggestedCollection).toBe('application_logs');
    expect(callOllamaFn).not.toHaveBeenCalled();
  });

  test('search documents (title/content/description) are recommended for elasticsearch, without calling Ollama', async () => {
    const rows = [
      { title: 'Getting started', content: 'Full guide...', description: 'Intro doc' },
      { title: 'Advanced usage', content: 'Deep dive...', description: 'Advanced doc' },
    ];
    const callOllamaFn = jest.fn();

    const result = await getRoutingRecommendation({ rows, originalName: 'articles.json', callOllamaFn });

    expectShape(result);
    expect(result.target).toBe('elasticsearch');
    expect(result.source).toBe('rules');
    expect(result.pattern).toBe('fullTextSearch');
    expect(callOllamaFn).not.toHaveBeenCalled();
  });

  test('falls back to the rule-based default when Ollama is unavailable', async () => {
    const rows = [
      { fruit: 'apple', color: 'red' },
      { fruit: 'banana', color: 'yellow' },
    ];
    const callOllamaFn = jest.fn().mockRejectedValue(new Error('Could not connect to Ollama at 127.0.0.1:11434.'));
    const buildPromptFn = jest.fn().mockReturnValue('prompt');

    const result = await getRoutingRecommendation({
      rows,
      originalName: 'fruit.csv',
      callOllamaFn,
      buildPromptFn,
    });

    expectShape(result);
    expect(result.source).toBe('fallback');
    expect(result.target).toBe('postgres'); // the weak default for plain tabular data
    expect(result.reason).toMatch(/unavailable/i);
  });

  test('falls back to the rule-based default when Ollama returns an invalid response', async () => {
    const rows = [
      { fruit: 'apple', color: 'red' },
      { fruit: 'banana', color: 'yellow' },
    ];
    const callOllamaFn = jest.fn().mockResolvedValue('I refuse to answer in JSON.');
    const buildPromptFn = jest.fn().mockReturnValue('prompt');

    const result = await getRoutingRecommendation({
      rows,
      originalName: 'fruit.csv',
      callOllamaFn,
      buildPromptFn,
    });

    expectShape(result);
    expect(result.source).toBe('fallback');
    expect(result.reason).toMatch(/could not be used/i);
  });

  test('falls back to the rule-based default when Ollama returns a target outside the allowed list', async () => {
    const rows = [
      { fruit: 'apple', color: 'red' },
      { fruit: 'banana', color: 'yellow' },
    ];
    const callOllamaFn = jest.fn().mockResolvedValue('{"target":"cassandra","confidence":"high","reason":"why not"}');
    const buildPromptFn = jest.fn().mockReturnValue('prompt');

    const result = await getRoutingRecommendation({
      rows,
      originalName: 'fruit.csv',
      callOllamaFn,
      buildPromptFn,
    });

    expectShape(result);
    expect(result.source).toBe('fallback');
  });

  test('the critical safety case: rules override Ollama when it recommends postgres for log-like data', async () => {
    // Only one log field ("message") — not enough to hit the hard
    // applicationLogs rule, so this reaches the Ollama branch. Ollama
    // is mocked to (incorrectly/unsafely) recommend postgres anyway.
    const rows = [
      { message: 'user login failed', requestId: 'r-1' },
      { message: 'user login succeeded', requestId: 'r-2' },
    ];
    const callOllamaFn = jest.fn().mockResolvedValue(
      '{"target":"postgres","confidence":"high","reason":"Looks like flat structured data."}',
    );
    const buildPromptFn = jest.fn().mockReturnValue('prompt');

    const result = await getRoutingRecommendation({
      rows,
      originalName: 'events.csv',
      callOllamaFn,
      buildPromptFn,
    });

    expectShape(result);
    expect(result.target).not.toBe('postgres');
    expect(result.target).toBe('elasticsearch');
    expect(result.source).toBe('rules');
    expect(result.reason).toMatch(/Overriding Ollama/i);
  });

  test('accepts a safe Ollama answer that does not conflict with the weak rule signal', async () => {
    const rows = [
      { fruit: 'apple', color: 'red' },
      { fruit: 'banana', color: 'yellow' },
    ];
    const callOllamaFn = jest.fn().mockResolvedValue(
      '{"target":"mongodb","confidence":"medium","reason":"Could work as a flexible document store too."}',
    );
    const buildPromptFn = jest.fn().mockReturnValue('prompt');

    const result = await getRoutingRecommendation({
      rows,
      originalName: 'fruit.csv',
      callOllamaFn,
      buildPromptFn,
    });

    expectShape(result);
    expect(result.source).toBe('ollama');
    expect(result.target).toBe('mongodb');
  });
});
