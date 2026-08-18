import { loadEnv } from '../../config/env.js';
import type {
  CommentaryStyle,
  ContentGenerationInput,
  GeneratedInfluencerContent,
} from '../../domain/content.js';
import { logger } from '../../observability/logger.js';
import { generateInfluencerPost } from '../../providers/openai/influencer.js';
import {
  establishedTakes,
  loadOpinionsForSubjects,
  loadPredictionForFixture,
  recordOpinions,
  recordPrediction,
  resolvePrediction,
  shouldSkipReceipt,
} from '../../services/bot-memory.js';
import { sampleInfluencerStyle } from '../../services/commentary-style.js';
import {
  addMinutes,
  loadContentJob,
  markJobStatus,
  saveSelectedStyle,
  type ContentJob,
} from '../../services/content-jobs.js';
import {
  loadFixtureById,
  resolveMatchReadiness,
  resultOutcome,
  toCompletedMatch,
  toUpcomingFixture,
  toVerifiedResult,
} from '../../services/influencer-context.js';
import { rankInfluencerCandidates } from '../../services/influencer-ranker.js';
import { publish } from '../../services/publisher.js';
import { loadRuntimeSettings } from '../../services/settings.js';
import { getSupabase } from '../../supabase/client.js';
import { QUEUES } from '../supabase-queues.js';
import { startConsumer } from './runner.js';

const APPROVED_CONTEXT: string[] = [
  'North London is Arsenal and Tottenham territory.',
  'Manchester derbies split the city red and blue.',
  'Merseyside derbies are Liverpool against Everton.',
];

async function recentPostTexts(limit = 20): Promise<string[]> {
  const { data } = await getSupabase()
    .from('published_posts')
    .select('post_text')
    .order('published_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map(row => row.post_text as string);
}

function fixtureIdFromJob(job: ContentJob): number {
  const fromPayload = Number(job.payload.fixtureId);
  if (Number.isFinite(fromPayload) && fromPayload > 0) return fromPayload;
  const fromSource = Number(job.source_id);
  if (Number.isFinite(fromSource) && fromSource > 0) return fromSource;
  throw new Error(`content job ${job.id} is missing fixtureId`);
}

async function recordInfluencerAttempt(
  job: ContentJob,
  attempt: number,
  content: GeneratedInfluencerContent,
  validationErrors: string[],
  style: CommentaryStyle,
): Promise<number> {
  const { data, error } = await getSupabase()
    .from('content_generations')
    .insert({
      match_event_id: null,
      content_job_id: job.id,
      attempt,
      model: loadEnv().OPENAI_TEXT_MODEL,
      post_text: content.postText,
      alt_text: '',
      referenced_facts: content.referencedFacts,
      opinion_claims: content.opinionClaims,
      risk: content.risk,
      validation_passed: validationErrors.length === 0,
      validation_errors: validationErrors,
      used_fallback_template: false,
      candidates: content.candidates ?? null,
      rank_debug: content.rankDebug ?? null,
      intent: job.intent,
      style,
    })
    .select('id')
    .single();
  if (error) throw new Error(`content_generations insert failed: ${error.message}`);
  return data.id;
}

async function buildInput(
  job: ContentJob,
  style: CommentaryStyle,
  tone: ContentGenerationInput['tone'],
  recent: string[],
): Promise<Exclude<ContentGenerationInput, { intent: 'live_reaction' }> | 'skip' | 'reschedule'> {
  const fixtureId = fixtureIdFromJob(job);
  const fixture = await loadFixtureById(fixtureId);

  if (job.intent === 'prediction') {
    if (fixture.status !== 'scheduled') return 'skip';
    const upcoming = toUpcomingFixture(fixture);
    const opinions = await loadOpinionsForSubjects([upcoming.home.name, upcoming.away.name]);
    return {
      intent: 'prediction',
      tone,
      style,
      approvedFacts: [
        ...APPROVED_CONTEXT,
        upcoming.home.name,
        upcoming.away.name,
        `Kickoff ${upcoming.kickoff}`,
        ...establishedTakes(opinions),
      ],
      recentOpenings: recent,
      fixture: upcoming,
    };
  }

  const readiness = await resolveMatchReadiness(fixture);
  if (readiness === 'postponed') return 'skip';
  if (readiness !== 'finished') return 'reschedule';

  const match = await toCompletedMatch(fixture);
  const result = toVerifiedResult(match);
  const opinions = await loadOpinionsForSubjects([match.home.name, match.away.name]);
  const approvedFacts = [
    ...APPROVED_CONTEXT,
    ...match.events,
    `Winner ${result.winner}`,
    ...establishedTakes(opinions),
  ];

  if (job.intent === 'post_match_verdict') {
    return {
      intent: 'post_match_verdict',
      tone,
      style,
      approvedFacts,
      recentOpenings: recent,
      match,
    };
  }

  if (job.intent === 'question') {
    return {
      intent: 'question',
      tone,
      style,
      approvedFacts,
      recentOpenings: recent,
      match: {
        fixtureId: match.fixtureId,
        home: match.home,
        away: match.away,
        phase: 'full_time',
      },
    };
  }

  if (job.intent === 'hot_take') {
    return {
      intent: 'hot_take',
      tone,
      style,
      approvedFacts,
      recentOpenings: recent,
      subject: { team: match.home.name },
    };
  }

  const prediction = await loadPredictionForFixture(String(fixtureId));
  if (shouldSkipReceipt(prediction)) return 'skip';
  return {
    intent: 'receipt',
    tone,
    style,
    approvedFacts: [...approvedFacts, `Stored prediction: ${prediction!.prediction}`],
    recentOpenings: recent,
    prediction: prediction!,
    result,
  };
}

async function persistMemory(
  job: ContentJob,
  content: GeneratedInfluencerContent,
  xPostId?: string,
): Promise<void> {
  const fixtureId = String(fixtureIdFromJob(job));

  if (job.intent === 'prediction') {
    await recordPrediction({
      fixtureId,
      prediction: content.postText,
      ...(xPostId ? { postId: xPostId } : {}),
    });
    return;
  }

  if (job.intent === 'receipt') {
    const stored = await loadPredictionForFixture(fixtureId);
    if (!stored) return;
    const fixture = await loadFixtureById(Number(fixtureId));
    const match = await toCompletedMatch(fixture);
    await resolvePrediction(stored.id, resultOutcome(stored.prediction, toVerifiedResult(match)));
    return;
  }

  if (job.intent === 'post_match_verdict' || job.intent === 'hot_take') {
    const fixture = await loadFixtureById(Number(fixtureId));
    const match = await toCompletedMatch(fixture);
    await recordOpinions({
      subjectType: 'match',
      subjectName: `${match.home.name} vs ${match.away.name}`,
      stances: content.opinionClaims,
      evidence: content.referencedFacts,
    });
  }
}

/**
 * Consumes `influencer-content`: scheduled verdicts, predictions and receipts.
 * Never calls generateCommentary or waits on image generation.
 */
export function startInfluencerContentConsumer(): () => void {
  return startConsumer(
    QUEUES.influencerContent,
    async msg => {
      const contentJobId = msg.message.contentJobId;
      if (!contentJobId) throw new Error('influencer job missing contentJobId');

      const job = await loadContentJob(contentJobId);
      if (job.status === 'completed' || job.status === 'skipped') {
        logger.debug({ contentJobId, status: job.status }, 'content job already settled; skipping');
        return;
      }

      await markJobStatus(job.id, 'processing');

      const settings = await loadRuntimeSettings();
      const style =
        job.style ?? sampleInfluencerStyle(job.intent, settings.banterTone);
      if (!job.style) await saveSelectedStyle(job.id, style);

      const recent = await recentPostTexts(20);
      const built = await buildInput(job, style, settings.banterTone, recent);

      if (built === 'skip') {
        await markJobStatus(job.id, 'skipped');
        logger.info({ contentJobId, intent: job.intent }, 'influencer job skipped');
        return;
      }
      if (built === 'reschedule') {
        await markJobStatus(job.id, 'pending', addMinutes(new Date(), 15));
        logger.info({ contentJobId, intent: job.intent }, 'match not finished; rescheduled 15m');
        return;
      }

      let approved: GeneratedInfluencerContent | undefined;
      for (let attempt = 1; attempt <= 2 && !approved; attempt++) {
        try {
          const output = await generateInfluencerPost(built);
          const { winner, ranked } = rankInfluencerCandidates(
            output,
            built.approvedFacts,
            recent,
            style,
          );
          if (winner) {
            await recordInfluencerAttempt(job, attempt, winner, [], style);
            approved = winner;
          } else {
            const failed: GeneratedInfluencerContent = {
              postText: ranked[0]?.postText ?? '',
              referencedFacts: output.referencedFacts,
              opinionClaims: output.opinionClaims,
              risk: output.risk,
              candidates: output.candidates,
              rankDebug: ranked.map(row => ({
                hook: row.candidate.hook,
                score: row.score,
                valid: row.valid,
                errors: row.errors,
              })),
            };
            await recordInfluencerAttempt(
              job,
              attempt,
              failed,
              ranked.flatMap(row => row.errors),
              style,
            );
            logger.warn({ contentJobId, attempt }, 'influencer content rejected');
          }
        } catch (error) {
          logger.warn({ contentJobId, attempt, error }, 'influencer generation call failed');
        }
      }

      if (!approved) {
        await markJobStatus(job.id, 'failed');
        logger.error({ contentJobId, intent: job.intent }, 'influencer generation failed');
        return;
      }

      const idempotencyKey = `influencer:${job.intent}:${job.source_id ?? job.id}`;
      const result = await publish({
        contentJobId: job.id,
        intent: job.intent,
        idempotencyKey,
        postText: approved.postText,
      });

      if (result.status === 'skipped' && result.reason !== 'dry_run') {
        await markJobStatus(job.id, 'pending', addMinutes(new Date(), 15));
        logger.info({ contentJobId, reason: result.reason }, 'influencer publish deferred');
        return;
      }

      await persistMemory(
        job,
        approved,
        result.status === 'skipped' ? undefined : result.xPostId,
      );
      await markJobStatus(job.id, 'completed');
    },
    { visibilityTimeout: 120 },
  );
}
