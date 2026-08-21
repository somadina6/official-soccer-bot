import { join } from 'node:path';
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const fileLogs = process.env.DEV_LOGS === '1';
const prettyLogs = process.env.PRETTY_LOGS === '1' || fileLogs;

const prettyTarget = {
  target: 'pino-pretty',
  level,
  options: {
    colorize: process.stdout.isTTY,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
  },
};

const fileTarget = {
  target: 'pino/file',
  level,
  options: {
    destination: join('logs', `${new Date().toISOString().slice(0, 10)}.log`),
    mkdir: true,
  },
};

/**
 * Structured logger. Redaction paths guarantee that secrets and raw
 * authorization headers never appear in log output (Phase 1 exit criterion).
 *
 * `npm run dev` sets DEV_LOGS=1 for pretty stdout plus a dated JSON file
 * under logs/. Set PRETTY_LOGS=1 on Heroku for readable `heroku logs --tail`
 * without writing to the dyno filesystem. Default production is stdout JSON.
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
  ...(prettyLogs
    ? {
        transport: {
          targets: fileLogs ? [prettyTarget, fileTarget] : [prettyTarget],
        },
      }
    : {}),
});
