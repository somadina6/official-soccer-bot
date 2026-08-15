import { loadEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import { getSupabase } from '../../supabase/client.js';

/**
 * OAuth 2.0 token management for the single bot account.
 *
 * The initial refresh token is obtained once through the Authorization Code +
 * PKCE flow (scopes: tweet.read, tweet.write, users.read, offline.access) and
 * seeded via X_REFRESH_TOKEN. X rotates refresh tokens on every use, so the
 * newest one is persisted in `account_settings` (server-side only) and the env
 * value acts as the bootstrap.
 */

type TokenState = {
  accessToken: string;
  /** Epoch ms after which the access token must be refreshed. */
  expiresAt: number;
  refreshToken: string;
};

let state: TokenState | undefined;

async function loadPersistedRefreshToken(): Promise<string> {
  const { data } = await getSupabase()
    .from('account_settings')
    .select('value')
    .eq('key', 'x_refresh_token')
    .maybeSingle();
  const persisted = typeof data?.value === 'string' ? data.value : undefined;
  return persisted ?? loadEnv().X_REFRESH_TOKEN;
}

async function persistRefreshToken(token: string): Promise<void> {
  const { error } = await getSupabase()
    .from('account_settings')
    .upsert({ key: 'x_refresh_token', value: JSON.stringify(token), updated_at: new Date().toISOString() });
  if (error) logger.error({ error: error.message }, 'failed to persist rotated X refresh token');
}

async function refreshAccessToken(): Promise<TokenState> {
  const env = loadEnv();
  const refreshToken = state?.refreshToken ?? (await loadPersistedRefreshToken());

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.X_CLIENT_ID,
  });

  const basic = Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${env.X_API_BASE_URL}/2/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`X token refresh failed (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const next: TokenState = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
    refreshToken: json.refresh_token ?? refreshToken,
  };
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    await persistRefreshToken(json.refresh_token);
  }
  state = next;
  return next;
}

/** Returns a valid user-context access token, refreshing when necessary. */
export async function getBotUserAccessToken(): Promise<string> {
  if (state && Date.now() < state.expiresAt) return state.accessToken;
  return (await refreshAccessToken()).accessToken;
}

/** Drops the cached token so the next call performs a fresh refresh. */
export function invalidateAccessToken(): void {
  if (state) state.expiresAt = 0;
}
