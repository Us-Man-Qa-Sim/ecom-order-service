import { z } from 'zod';

const numericString = (defaultValue: number) =>
  z
    .string()
    .default(String(defaultValue))
    .transform((value, ctx) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: 'custom', message: `${value} is not a number` });
        return z.NEVER;
      }
      return parsed;
    });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  GRPC_HOST: z.string().default('0.0.0.0'),
  GRPC_PORT: numericString(5003),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: numericString(8083),

  DATABASE_URL: z.string().url(),

  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('order-service'),
  KAFKA_CONSUMER_GROUP_ID: z.string().default('order-service'),

  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_RELAY_POLL_INTERVAL_MS: numericString(250),
  OUTBOX_RELAY_BATCH_SIZE: numericString(32),
  OUTBOX_RELAY_ERROR_BACKOFF_MS: numericString(5_000),

  USER_SERVICE_URL: z.string().default('localhost:5001'),
  PRODUCT_SERVICE_URL: z.string().default('localhost:5002'),

  GRPC_TIMEOUT_FAST_MS: numericString(2_000),
  GRPC_TIMEOUT_STANDARD_MS: numericString(5_000),
  GRPC_TIMEOUT_LONG_MS: numericString(10_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return parsed.data;
}
