import Fastify from 'fastify';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { loadRuntimeSettings, setSetting } from '../services/settings.js';

/**
 * Health endpoint plus minimal admin controls (pause switch, dry-run, tone,
 * per-event enablement). Runs on the Railway worker; a future dashboard
 * should use an authenticated restricted role instead.
 */
export async function startApiServer(): Promise<() => Promise<void>> {
  const env = loadEnv();
  const app = Fastify({ loggerInstance: logger.child({ component: 'api' }) as never });

  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/admin/settings', async () => {
    const settings = await loadRuntimeSettings();
    return { ...settings, enabledEventTypes: [...settings.enabledEventTypes] };
  });

  const SettingsPatchSchema = z.object({
    publishing_enabled: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    manual_approval: z.boolean().optional(),
    banter_tone: z.enum(['neutral', 'playful', 'spicy']).optional(),
    enabled_event_types: z.array(z.string()).optional(),
  });

  app.patch('/admin/settings', async (request, reply) => {
    const parsed = SettingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) await setSetting(key, value);
    }
    return { updated: Object.keys(parsed.data) };
  });

  // Emergency kill switch: flips the DB setting; the env var must also be
  // true for publishing, so this can only make the system safer.
  app.post('/admin/pause', async () => {
    await setSetting('publishing_enabled', false);
    return { publishing_enabled: false };
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT }, 'API server listening');
  return async () => app.close();
}
