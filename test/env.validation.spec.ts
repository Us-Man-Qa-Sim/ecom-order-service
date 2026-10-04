import { validateEnv } from '../src/config/env.validation';

describe('env.validation', () => {
  const valid = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  };

  it('accepts defaults with only DATABASE_URL', () => {
    const env = validateEnv(valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.GRPC_PORT).toBe(5003);
    expect(env.HTTP_PORT).toBe(8083);
    expect(env.KAFKA_CLIENT_ID).toBe('order-service');
    expect(env.OUTBOX_RELAY_ENABLED).toBe(true);
    expect(env.USER_SERVICE_URL).toBe('localhost:5001');
    expect(env.PRODUCT_SERVICE_URL).toBe('localhost:5002');
  });

  it('coerces numeric strings', () => {
    const env = validateEnv({ ...valid, GRPC_PORT: '9999', HTTP_PORT: '7777' });
    expect(env.GRPC_PORT).toBe(9999);
    expect(env.HTTP_PORT).toBe(7777);
  });

  it('rejects non-numeric port', () => {
    expect(() => validateEnv({ ...valid, GRPC_PORT: 'abc' })).toThrow('not a number');
  });

  it('rejects unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...valid, NODE_ENV: 'staging' })).toThrow();
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow();
  });

  it('accepts all log levels', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']) {
      const env = validateEnv({ ...valid, LOG_LEVEL: level });
      expect(env.LOG_LEVEL).toBe(level);
    }
  });
});
