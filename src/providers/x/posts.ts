import { loadEnv } from '../../config/env.js';
import { getBotUserAccessToken } from './auth.js';

export type CreatePostInput = {
  text: string;
  mediaId?: string;
  /** For VAR corrections: link the correction as a reply to the original post. */
  inReplyToPostId?: string;
};

/**
 * Creates the post via POST /2/tweets. `made_with_ai: true` is set because
 * every post carries AI-generated media.
 */
export async function createPost(input: CreatePostInput): Promise<string> {
  const env = loadEnv();
  const body: Record<string, unknown> = {
    text: input.text,
    made_with_ai: true,
  };
  if (input.mediaId) body.media = { media_ids: [input.mediaId] };
  if (input.inReplyToPostId) body.reply = { in_reply_to_tweet_id: input.inReplyToPostId };

  const response = await fetch(`${env.X_API_BASE_URL}/2/tweets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await getBotUserAccessToken()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`X ${response.status}: ${await response.text()}`);

  const json = (await response.json()) as { data?: { id?: string } };
  if (!json.data?.id) throw new Error('X post creation returned no post ID');
  return json.data.id;
}
