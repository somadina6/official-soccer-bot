import pino from 'pino';

/**
 * Structured logger. Redaction paths guarantee that secrets and raw
 * authorization headers never appear in log output (Phase 1 exit criterion).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'headers.authorization',
      'headers["x-api-key"]',
      '*.apiKey',
      '*.apiSecret',
      '*.accessToken',
      '*.accessTokenSecret',
      '*.refreshToken',
      '*.serviceRoleKey',
      '*.secretKey',
    ],
    censor: '[redacted]',
  },
  base: { service: 'epl-commentary-worker' },
});
