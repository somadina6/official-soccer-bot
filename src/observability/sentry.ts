import * as Sentry from '@sentry/node';
import type { Env } from '../config/env.js';
import { logger } from './logger.js';

export function initSentry(env: Env): void {
  if (!env.SENTRY_DSN) {
    logger.info('Sentry DSN not set; error reporting disabled');
    return;
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.05,
  });
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  logger.error({ error, ...context }, 'captured error');
  Sentry.captureException(error, { extra: context ?? {} });
}
