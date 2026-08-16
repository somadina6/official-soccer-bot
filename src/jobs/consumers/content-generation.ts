import { loadEnv } from '../../config/env.js';
import type { GeneratedContent } from '../../domain/content.js';
import { logger } from '../../observability/logger.js';
import { fallbackTemplate, generateCommentary } from '../../providers/openai/commentary.js';
import { extractApprovedIncidentFacts } from '../../providers/sportsapi/mapper.js';
import { validateContent } from '../../services/content-policy.js';
import { loadRuntimeSettings } from '../../services/settings.js';
import { getSupabase } from '../../supabase/client.js';
import { QUEUES } from '../supabase-queues.js';
import { maybeEnqueueXPublishing } from './publish-join.js';
import { startConsumer } from './runner.js';
import { loadEvent, setEventState } from './shared.js';

/**
 * Operator-approved rivalry/context lines. Kept deliberately small; the model
 * may not use any fact outside the event payload, these lines, and the
 * whitelisted incident facts extracted from the raw provider payload.
 */
const APPROVED_CONTEXT: string[] = [
  'North London is Arsenal and Tottenham territory.',
  'Manchester derbies split the city red and blue.',
  'Merseyside derbies are Liverpool against Everton.',
];

async function recentPostTexts(limit = 10): Promise<string[]> {
  const { data } = await getSupabase()
    .from('published_posts')
    .select('post_text')
    .order('published_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map(row => row.post_text as string);
}

async function recordAttempt(
  matchEventId: number,
  attempt: number,
  content: GeneratedContent,
  validationErrors: string[],
  usedFallback: boolean,
): Promise<number> {
  const { data, error } = await getSupabase()
    .from('content_generations')
    .insert({
      match_event_id: matchEventId,
      attempt,
      model: usedFallback ? 'fallback-template' : loadEnv().OPENAI_TEXT_MODEL,
      post_text: content.postText,
      image_prompt: content.imagePrompt,
      alt_text: content.altText,
      referenced_facts: content.referencedFacts,
      risk: content.risk,
      validation_passed: validationErrors.length === 0,
      validation_errors: validationErrors,
      used_fallback_template: usedFallback,
    })
    .select('id')
    .single();
  if (error) throw new Error(`content_generations insert failed: ${error.message}`);
  return data.id;
}

/**
 * Consumes `content-generation`: generates commentary with structured output,
 * validates it deterministically, and falls back to the safe template after
 * two failed attempts so the event is never missed.
 */
export function startContentGenerationConsumer(): () => void {
  return startConsumer(
    QUEUES.contentGeneration,
    async msg => {
      const { matchEventId, idempotencyKey } = msg.message;
      const row = await loadEvent(matchEventId);
      if (!['CONFIRMED', 'GENERATING'].includes(row.state)) {
        logger.debug({ matchEventId, state: row.state }, 'event not awaiting generation; skipping');
        return;
      }
      await setEventState(matchEventId, 'GENERATING');

      const settings = await loadRuntimeSettings();
      const recent = await recentPostTexts();
      const contextDictionary = [
        ...APPROVED_CONTEXT,
        ...extractApprovedIncidentFacts(row.rawPayload),
      ];

      let approved: { content: GeneratedContent; generationId: number } | undefined;

      for (let attempt = 1; attempt <= 2 && !approved; attempt++) {
        let content: GeneratedContent;
        try {
          content = await generateCommentary({
            event: row.event,
            tone: settings.banterTone,
            contextDictionary,
            recentOpenings: recent,
          });
        } catch (error) {
          logger.warn({ matchEventId, attempt, error }, 'commentary generation call failed');
          continue;
        }
        const result = validateContent(content, row.event, recent, contextDictionary);
        const generationId = await recordAttempt(
          matchEventId,
          attempt,
          content,
          result.valid ? [] : result.errors,
          false,
        );
        if (result.valid) approved = { content, generationId };
        else logger.warn({ matchEventId, attempt, errors: result.errors }, 'generated content rejected');
      }

      if (!approved) {
        logger.warn({ matchEventId, attempt: 3 }, 'fallback template used');
        const fallback = fallbackTemplate(row.event);
        const result = validateContent(fallback, row.event, recent, contextDictionary);
        const generationId = await recordAttempt(
          matchEventId,
          3,
          fallback,
          result.valid ? [] : result.errors,
          true,
        );
        if (!result.valid) {
          // Even the deterministic template failed validation (should not
          // happen); a human needs to look at this event.
          await setEventState(matchEventId, 'MANUAL_REVIEW');
          logger.error({ matchEventId, errors: result.errors }, 'fallback template rejected');
          return;
        }
        approved = { content: fallback, generationId };
      }

      await setEventState(matchEventId, 'VALIDATED');
      await maybeEnqueueXPublishing(matchEventId, idempotencyKey);
    },
    { visibilityTimeout: 120 },
  );
}
