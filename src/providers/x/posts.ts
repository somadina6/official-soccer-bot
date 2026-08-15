import { ApiResponseError, type SendTweetV2Params } from 'twitter-api-v2';
import { getXClient } from './auth.js';

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
  const payload: SendTweetV2Params & { made_with_ai: true } = {
    text: input.text,
    made_with_ai: true,
  };
  if (input.mediaId) payload.media = { media_ids: [input.mediaId] };
  if (input.inReplyToPostId) payload.reply = { in_reply_to_tweet_id: input.inReplyToPostId };

  try {
    const posted = await getXClient().v2.tweet(payload);
    const id = posted.data?.id;
    if (!id) throw new Error('X post creation returned no post ID');
    return id;
  } catch (error) {
    if (error instanceof ApiResponseError) {
      throw new Error(`X ${error.code}: ${error.message}`);
    }
    throw error;
  }
}
