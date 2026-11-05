const { redactSensitive } = require('../redact');

describe('redactSensitive', () => {
  test('redacts protocol://user:pass@host', () => {
    expect(redactSensitive('mongodb://admin:hunter2@localhost:27017/shop')).toBe(
      'mongodb://[REDACTED]@localhost:27017/shop',
    );
  });

  test('redacts a bare user:pass@host with no protocol prefix', () => {
    expect(redactSensitive('connect ECONNREFUSED user:s3cr3t@127.0.0.1:5432')).toBe(
      'connect ECONNREFUSED [REDACTED]@127.0.0.1:5432',
    );
  });

  test('redacts password/secret/token/api-key assignments', () => {
    expect(redactSensitive('password: hunter2')).toBe('password: [REDACTED]');
    expect(redactSensitive('PWD=hunter2')).toBe('PWD=[REDACTED]');
    expect(redactSensitive('api-key: abc123')).toBe('api-key: [REDACTED]');
    expect(redactSensitive('token=xyz789')).toBe('token=[REDACTED]');
  });

  test('leaves ordinary error messages untouched', () => {
    const message = 'relation "orders" does not exist';
    expect(redactSensitive(message)).toBe(message);
  });

  test('passes through falsy input unchanged', () => {
    expect(redactSensitive('')).toBe('');
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
  });
});
