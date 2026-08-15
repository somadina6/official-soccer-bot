# Premier League AI Commentary Bot

An always-on Node.js worker that detects important live Premier League events (goals, red cards, missed penalties, VAR decisions, full time), writes short punchy commentary with an AI text model, composes a 1:1 editorial illustration with a deterministic score overlay, and publishes to X (Twitter).

Built from `premier-league-ai-twitter-bot-implementation-plan.md`.

## Stack

- **Node.js 22 + TypeScript** worker (designed for Railway)
- **SportsAPI Pro Football V2** — live data (WebSocket + REST reconciliation)
- **Supabase Postgres** — event ledger, fixtures, settings (RLS enabled)
- **Supabase Queues (pgmq)** — durable jobs with retries and dead-lettering
- **OpenAI** — structured-output commentary + pre-generated fixture artwork
- **sharp** — deterministic score/minute overlay composition
- **X API v2** — media upload, alt text and post creation via `twitter-api-v2` (OAuth 1.0a user context)

## Getting started

```bash
npm install
cp .env.example .env   # fill in real values; placeholders included
```

1. Create/choose a Supabase project and enable the **Queues** integration (installs `pgmq`).
2. Run the migrations in order against your project:
   - `src/supabase/migrations/0001_init.sql` (tables, RLS, seeds)
   - `src/supabase/migrations/0002_queues.sql` (the six logged Basic Queues)
3. Optionally create a private Storage bucket named `generated-match-media` (or clear `SUPABASE_STORAGE_BUCKET` to stream images directly to X).
4. Copy the bot account's OAuth 1.0a user tokens into `TWITTER_CONSUMER_KEY`, `TWITTER_CONSUMER_SECRET`, `TWITTER_ACCESS_TOKEN` and `TWITTER_ACCESS_SECRET` (same names as `twitter-api-v2`). The access token must have read and write permission.
5. Start the worker:

```bash
npm run dev        # watch mode
npm run build && npm start
```

## Safety defaults

The worker boots in the safest possible configuration:

- `DRY_RUN=true` — the whole pipeline runs, but final posts are logged, not sent.
- `PUBLISHING_ENABLED=false` — even outside dry-run, nothing posts until both the env var **and** the `publishing_enabled` database setting are true.
- Circuit breaker: max 12 posts / 15 min, 100 / day, auto-pause after 3 consecutive X auth failures.
- `POST /admin/pause` is the emergency kill switch; `PATCH /admin/settings` controls tone, dry-run, manual approval and per-event enablement at runtime.

## How it works

1. **Discovery:** the Premier League tournament ID is discovered via SportsAPI search (never hardcoded) and stored in `competitions`. Today's and tomorrow's schedules are synced on boot, every 6 hours, and after midnight UTC; `/live` is the recovery fallback.
2. **Ingestion:** one WebSocket subscribes to `live-scores` plus `match:{id}` / `match:{id}:incidents` for allow-listed fixtures. Every payload is normalized into a stable `MatchEvent` and ingested idempotently — replaying the same feed produces zero duplicates.
3. **Confirmation:** goals wait a 12-second VAR window, then are re-verified against REST incidents before any content is generated. Overturned published goals get a correction posted as a reply.
4. **Content:** structured-output commentary is validated deterministically (facts, length, banned topics, repetition). Two failures fall back to a safe template so no event is missed.
5. **Visuals:** three abstract backgrounds are pre-generated per fixture before kick-off (no logos or likenesses); `sharp` overlays the exact event label, player, minute and score at post time.
6. **Publishing:** image upload, alt text (with AI disclosure), and `made_with_ai: true` post creation — all idempotent, keyed on the event's idempotency key.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run the worker with live reload |
| `npm run build` / `npm start` | Compile and run production build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the vitest suite |

## Event lifecycle

`RECEIVED → PENDING_CONFIRMATION → CONFIRMED → GENERATING → VALIDATED → PUBLISHING → PUBLISHED`

Terminal alternatives: `IGNORED`, `OVERTURNED`, `FAILED`, `MANUAL_REVIEW`.

## Notes before launch

- The SportsAPI payload schemas in `src/providers/sportsapi/mapper.ts` are written against the documented shapes but **must be validated against recorded live responses** (plan Phase 0/2) before trusting them.
- Run shadow mode (dry run) for two match weekends and compare detected events against match reports before enabling publishing.
- The X account bio must disclose that it is an automated bot and name the responsible operator.
