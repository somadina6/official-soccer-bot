import { join } from 'node:path';
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const devLogs = process.env.DEV_LOGS === '1';

/**
 * Structured logger. Redaction paths guarantee that secrets and raw
 * authorization headers never appear in log output (Phase 1 exit criterion).
 *
 * `npm run dev` sets DEV_LOGS=1 so the same events go to a pretty terminal
 * stream and a dated JSON file under logs/. Production stays stdout JSON.
 */
export const logger = pino({
  level,
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
  ...(devLogs
    ? {
        transport: {
          targets: [
            {
              target: 'pino-pretty',
              level,
              options: { colorize: true, translateTime: 'SYS:standard' },
            },
            {
              target: 'pino/file',
              level,
              options: {
                destination: join('logs', `${new Date().toISOString().slice(0, 10)}.log`),
                mkdir: true,
              },
            },
          ],
        },
      }
    : {}),
});
