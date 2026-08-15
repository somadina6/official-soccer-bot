import { TwitterApi } from 'twitter-api-v2';
import { loadEnv } from '../../config/env.js';

/**
 * OAuth 1.0a user-context client for the bot account.
 * Keys come from the developer portal and do not expire or rotate.
 */
let client: TwitterApi | undefined;

export function getXClient(): TwitterApi {
  if (client) return client;
  const env = loadEnv();
  client = new TwitterApi({
    appKey: env.TWITTER_CONSUMER_KEY,
    appSecret: env.TWITTER_CONSUMER_SECRET,
    accessToken: env.TWITTER_ACCESS_TOKEN,
    accessSecret: env.TWITTER_ACCESS_SECRET,
  });
  return client;
}
