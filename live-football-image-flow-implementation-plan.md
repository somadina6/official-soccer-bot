# Live Football Event Image Flow — Implementation Plan

## 1. Purpose

Implement the image-only pipeline for the Premier League event bot. The pipeline begins when the application receives a normalized, confirmed match event and ends when a JPEG has been generated, branded, stored in Supabase, and uploaded to X with a reusable `media_id`.

This plan deliberately excludes:

- discovering fixtures or subscribing to live matches;
- validating or deduplicating raw sports-provider messages before they become confirmed events;
- generating the written commentary;
- deciding whether an event is tweet-worthy;
- creating the final X post.

## 2. Final technical decisions

| Decision | Selection |
|---|---|
| Image model | `gpt-image-2` through the OpenAI Image API |
| Render quality | `low` |
| Canvas | `1536x1024` landscape |
| Generated format | JPEG |
| API compression | `output_compression: 85` |
| Art direction | Photorealistic editorial sports photography with recognizable player resemblance |
| Factual text | Added deterministically with Sharp, never generated inside the artwork |
| Persistent storage | Private Supabase Storage bucket |
| X handoff | Upload the JPEG bytes to `POST /2/media/upload`; retain the returned `media_id` |
| Primary idempotency key | Sports provider's stable event ID, scoped by fixture |
| Failure strategy | Reuse an existing stored image or use a cached fallback; never regenerate because an X upload failed |

The selected `1536x1024` low-quality output currently costs approximately **$0.005 per generated image**, plus a small text-input charge. The output price is therefore approximately $0.50 per 100 images or $5 per 1,000 images.

## 3. End-to-end flow

```text
ConfirmedEvent
      |
      v
Claim idempotent image job in Postgres
      |
      +---- existing completed job ----> reuse stored JPEG/X media ID
      |
      v
Build versioned editorial-photography prompt
      |
      v
Generate JPEG with GPT Image 2 low
      |
      v
Decode and validate image bytes
      |
      v
Add factual overlay with Sharp
      |
      v
Enforce JPEG and X's 5 MB limit
      |
      v
Upload immutable object to Supabase Storage
      |
      v
Upload same in-memory bytes to X
      |
      v
Persist X media ID and expiry
      |
      v
Return ImageResult to the post-publishing flow
```

Generation and written-commentary creation can run concurrently in the wider application, but they remain separate services.

## 4. Input and output contracts

### Confirmed event input

```ts
export type ConfirmedEvent = {
  provider: string;
  providerEventId: string;
  fixtureId: string;
  season: string;
  eventType: "goal" | "red_card" | "penalty" | "full_time";
  occurredAt: string;
  minute: number;
  addedTime?: number;
  playerName?: string;
  teamName: string;
  opponentName: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  teamColors: string[];
  venue?: string;
};
```

### Image pipeline output

```ts
export type ImageResult = {
  eventKey: string;
  bucket: "event-images";
  storagePath: string;
  mimeType: "image/jpeg";
  byteLength: number;
  width: number;
  height: number;
  xMediaId: string;
  xMediaExpiresAt: string;
  usedFallback: boolean;
};
```

Construct the stable event key as:

```ts
const eventKey = `${event.provider}:${event.fixtureId}:${event.providerEventId}`;
```

Do not use the minute, score, player name, or a generated UUID as the primary deduplication key.

## 5. Supabase data model

Create one `image_jobs` row per stable event key.

```sql
create table public.image_jobs (
  event_key text primary key,
  provider text not null,
  provider_event_id text not null,
  fixture_id text not null,
  event_type text not null,
  status text not null check (status in (
    'pending',
    'generating',
    'compositing',
    'stored',
    'uploaded_to_x',
    'fallback_used',
    'failed'
  )),
  prompt_version text not null,
  model text not null default 'gpt-image-2',
  quality text not null default 'low',
  size text not null default '1536x1024',
  storage_bucket text,
  storage_path text,
  byte_length integer,
  generation_attempts integer not null default 0,
  generation_duration_ms integer,
  used_fallback boolean not null default false,
  x_media_id text,
  x_media_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index image_jobs_provider_event_unique
  on public.image_jobs (provider, fixture_id, provider_event_id);
```

Do not store the OpenAI API key, X access token, full X authorization headers, or Supabase service-role key in this table.

## 6. Supabase bucket design

Create a private bucket named `event-images` with:

- allowed MIME type: `image/jpeg`;
- maximum file size: `5 MB`, matching X's current image limit;
- server-only writes using the Supabase service-role credential;
- reads limited to the server worker;
- no public URL requirement because X receives the image bytes, not a Supabase URL.

Use immutable, versioned paths:

```text
events/{season}/{fixtureId}/{providerEventId}/prompt-v2.jpg
```

Example:

```text
events/2026-27/123456/987654/prompt-v2.jpg
```

Keep fallback artwork in a separate prefix or bucket:

```text
fallbacks/{eventType}/{teamSlug}.jpg
```

Always upload generated event images with `upsert: false`. A duplicate-object response should trigger reuse of the existing object, not overwriting it. This avoids stale CDN content and makes concurrent processing safer.

## 7. Module layout

```text
src/image-flow/
  image-pipeline.ts
  image-job.repository.ts
  prompt-builder.ts
  gpt-image.generator.ts
  image-validator.ts
  image-compositor.ts
  supabase-image.store.ts
  x-media.uploader.ts
  fallback-image.service.ts
  types.ts
  errors.ts
```

Each module should have one responsibility. The orchestrator should not contain prompt wording, SVG markup, SQL, or raw HTTP authentication logic.

## 8. Prompt construction

Maintain prompts as versioned application code. Store the version, not only the resulting path, in `image_jobs`.

```ts
export const IMAGE_PROMPT_VERSION = "prompt-v2";

export function buildEventImagePrompt(event: ConfirmedEvent): string {
  const player = event.playerName ?? `a ${event.teamName} player`;
  const kitColor = event.teamColors[0] ?? "#6CADDF";

  return `
Photorealistic editorial sports photograph of ${player}
celebrating immediately after scoring, full-body action pose, sprinting toward
the corner, authentic athletic movement, balanced natural anatomy, realistic
hands and face, visible emotion, sweat and fabric detail.

Wearing a generic ${kitColor} football kit without logos, badges, sponsors
or readable text. Packed English football stadium at night, supporters softly
blurred in the background, dramatic floodlights, shallow depth of field,
85mm sports photography, 1/1000 second shutter speed, crisp subject,
cinematic colour grading.

No scoreboard, lettering, watermark, duplicate people, distorted limbs,
extra fingers or official branding.
  `.trim();
}
```

Prompt rules:

- Use this exact template for goal events.
- Use the player name when it is supplied by the confirmed event; for example, `Erling Haaland`.
- Set `kitColor` from the event team's configured primary colour; for Manchester City's sky-blue treatment, use `#6CADDF`.
- Describe stable identifying features when the event feed or an approved player profile provides them.
- Do not invent appearance details when they are unavailable.
- Keep all factual score and event text out of the generated artwork.
- Keep the style photorealistic and editorial, with authentic sports movement and natural anatomy.
- Do not request official badges, sponsor marks or league branding.
- Treat resemblance as best-effort; it will vary by player prominence and the model's consistency.
- Create separate photorealistic templates for red cards, penalties and full time rather than inserting those event types into the goal-celebration wording.

## 9. GPT Image generation

Use the Image API because this pipeline creates one image from one prompt and does not need a multi-turn editing conversation.

```ts
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateEventArtwork(prompt: string): Promise<Buffer> {
  const response = await openai.images.generate({
    model: "gpt-image-2",
    prompt,
    quality: "low",
    size: "1536x1024",
    output_format: "jpeg",
    output_compression: 85,
    n: 1,
  });

  const encoded = response.data[0]?.b64_json;
  if (!encoded) throw new Error("IMAGE_GENERATION_EMPTY_RESULT");

  return Buffer.from(encoded, "base64");
}
```

Operational policy:

- Set a 30-second product deadline for the live image path.
- Record actual generation duration separately from total pipeline duration.
- Retry a `429` or `5xx` once with short jitter only when enough deadline remains.
- Do not automatically retry `moderation_blocked` or another user-correctable prompt error with the same prompt.
- After the deadline, use the fallback path so image generation cannot indefinitely block the live post.
- Be aware that a client-side timeout may not guarantee cancellation of a request already being processed; track timed-out calls in cost metrics.

## 10. Validation and deterministic overlay

Before compositing, use Sharp metadata to verify that:

- bytes decode as an image;
- the decoded format is JPEG;
- dimensions are non-zero and within expected limits;
- the object is not suspiciously small or empty.

Generate the scoreboard/event overlay as SVG and composite it with Sharp. The overlay is the source of truth for:

- event label, such as `GOAL` or `RED CARD`;
- match minute and added time;
- player name;
- home and away teams;
- confirmed score.

```ts
const finalImageBuffer = await sharp(generatedBuffer)
  .rotate()
  .resize(1536, 1024, { fit: "cover", position: "attention" })
  .composite([{ input: overlaySvg, gravity: "southwest" }])
  .jpeg({ quality: 85, progressive: true, chromaSubsampling: "4:4:4" })
  .toBuffer();
```

Overlay requirements:

- Maintain high contrast at mobile-feed size.
- Keep essential text inside safe margins.
- Use a bundled font so Railway/container rendering is deterministic.
- Escape all dynamic strings before inserting them into SVG.
- Truncate or scale long player/team names using tested layout rules.
- Do not add factual text through the image model.

After compositing, validate again. If the JPEG is above 4.8 MB, re-encode at quality 80. If it remains above 4.8 MB, reduce dimensions while retaining the landscape ratio. Use 4.8 MB as the internal ceiling to leave headroom below X's 5 MB restriction.

## 11. Supabase upload

Upload the finalized JPEG before contacting X so a durable retry source exists.

```ts
export async function storeEventImage(
  storagePath: string,
  jpeg: Buffer,
) {
  const { data, error } = await supabase.storage
    .from("event-images")
    .upload(storagePath, jpeg, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) throw error;
  return data.path;
}
```

If the object already exists:

1. load the corresponding `image_jobs` row;
2. verify that its stored path matches the expected immutable path;
3. download and validate the existing JPEG;
4. continue to X upload without calling GPT Image again.

## 12. X media upload handoff

Upload the same in-memory `finalImageBuffer` used for Supabase. Do not immediately download it again. X's current v2 flow is:

1. upload image bytes to `POST /2/media/upload` with `media_category: "tweet_image"` and `media_type: "image/jpeg"`;
2. receive the media identifier and expiry;
3. store both on `image_jobs`;
4. return the media identifier to the separate post-publishing service.

Conceptual request body:

```ts
const body = {
  media: finalImageBuffer.toString("base64"),
  media_category: "tweet_image",
  media_type: "image/jpeg",
  shared: false,
};
```

The uploader module owns X authentication and response parsing. The image pipeline should receive only a typed result:

```ts
type XMediaUploadResult = {
  mediaId: string;
  expiresAfterSeconds: number;
};
```

Persist `x_media_expires_at = now() + expiresAfterSeconds`. If the post operation happens after expiry, upload the stored Supabase JPEG again; do not regenerate the artwork.

## 13. Pipeline orchestration

```ts
export async function prepareEventImage(
  event: ConfirmedEvent,
): Promise<ImageResult> {
  const eventKey = createEventKey(event);
  const job = await imageJobs.claim(eventKey, event);

  if (job.xMediaId && !isExpired(job.xMediaExpiresAt)) {
    return imageJobs.toResult(job);
  }

  let finalJpeg: Buffer;
  let usedFallback = false;

  if (job.storagePath) {
    finalJpeg = await imageStore.download(job.storagePath);
  } else {
    try {
      await imageJobs.markGenerating(eventKey);
      const prompt = buildEventImagePrompt(event);
      const generated = await generator.generate(prompt);
      await imageValidator.validateGenerated(generated);

      await imageJobs.markCompositing(eventKey);
      finalJpeg = await compositor.addEventOverlay(generated, event);
      finalJpeg = await imageValidator.enforceXLimit(finalJpeg);
    } catch (error) {
      finalJpeg = await fallbacks.resolve(event);
      usedFallback = true;
    }

    const path = buildImmutableStoragePath(event, IMAGE_PROMPT_VERSION);
    await imageStore.upload(path, finalJpeg);
    await imageJobs.markStored(eventKey, path, finalJpeg.length, usedFallback);
  }

  const xMedia = await xMediaUploader.uploadJpeg(finalJpeg);
  return imageJobs.markUploadedToX(eventKey, xMedia);
}
```

Production code must use a transactional or atomic claim operation so two workers cannot both generate the same event image.

## 14. Idempotency and retry matrix

| Existing state | Action |
|---|---|
| No job | Atomically create job and generate |
| `generating` with a fresh lease | Exit; another worker owns it |
| `generating` with an expired lease | Reclaim according to worker policy |
| Stored JPEG, no X media ID | Download from Supabase and upload to X |
| Valid X media ID | Return it immediately |
| Expired X media ID | Re-upload stored JPEG to X |
| X upload failed | Retry X upload only |
| GPT request failed before storage | Use fallback; optionally schedule non-live regeneration separately |
| Supabase object already exists | Reuse and validate the existing object |
| Duplicate sports event | Return the original job/result |

Generation attempts should be counted independently from X upload attempts so cost and reliability remain measurable.

## 15. Error handling

Define stable internal error codes:

```text
IMAGE_GENERATION_TIMEOUT
IMAGE_GENERATION_RATE_LIMITED
IMAGE_GENERATION_MODERATION_BLOCKED
IMAGE_GENERATION_EMPTY_RESULT
IMAGE_DECODE_FAILED
IMAGE_COMPOSITE_FAILED
IMAGE_TOO_LARGE
STORAGE_UPLOAD_FAILED
STORAGE_DOWNLOAD_FAILED
X_MEDIA_UPLOAD_FAILED
FALLBACK_NOT_FOUND
```

Log provider request IDs when available, but never log credentials or the entire base64 image. Limit stored error messages to sanitized diagnostic text.

## 16. Observability

Capture these metrics:

- jobs started, completed, deduplicated and failed;
- generated images versus fallback images;
- generation p50, p90 and p95 latency;
- total confirmed-event-to-`media_id` latency;
- OpenAI attempt count and estimated cost;
- moderation-blocked and timeout rate;
- Sharp processing duration;
- final JPEG byte-size distribution;
- Supabase upload/download failures;
- X media-upload failures and expired-media reuploads;
- resemblance/visual acceptance rate from manual review.

Attach `eventKey`, `fixtureId`, `providerEventId`, `promptVersion` and `storagePath` to structured logs.

## 17. Testing plan

### Unit tests

- event-key construction;
- deterministic storage-path construction;
- prompt generation for each supported event type;
- missing-player fallback wording;
- SVG escaping for apostrophes, ampersands and accented names;
- overlay layout for very long names;
- byte-size re-encoding thresholds;
- X media-expiry calculation;
- retry classification for `429`, `5xx`, moderation and validation errors.

### Integration tests

- mocked OpenAI response -> JPEG decode -> Sharp overlay -> validation;
- Supabase upload with `image/jpeg` metadata;
- duplicate Supabase path behavior;
- stored-image recovery after a simulated process crash;
- mocked X media upload and persisted expiry;
- X failure followed by retry without a second OpenAI call;
- simultaneous workers attempting the same event key.

### Visual regression tests

Render fixtures for:

- goal;
- red card;
- penalty;
- full time;
- long team and player names;
- missing player;
- light and dark generated backgrounds.

Compare overlay geometry, safe margins and readability. Do not pixel-match the model-generated artwork itself.

### Model benchmark before launch

Generate at least 30–50 representative prompts spanning:

- widely recognized players;
- less prominent players;
- multiple skin tones and hairstyles;
- different clubs and team colors;
- goals, cards and full-time scenes.

Record generation latency, anatomy errors, resemblance, moderation blocks, file size and mobile-feed readability. Use the benchmark to confirm the 30-second deadline and fallback rate.

## 18. Delivery phases

### Phase 1 — Storage and schema

- Create `image_jobs` migration.
- Create the private `event-images` bucket.
- Configure JPEG-only MIME restriction and 5 MB limit.
- Implement repository claim, lease and state-transition methods.

**Exit criterion:** one event can safely claim exactly one image job under concurrent tests.

### Phase 2 — Generation and compositing

- Implement versioned prompt builder.
- Integrate `gpt-image-2` low-quality JPEG generation.
- Implement decode/metadata validation.
- Build Sharp SVG overlay templates for supported events.
- Enforce final byte-size ceiling.

**Exit criterion:** test events consistently produce valid, readable JPEGs below 4.8 MB.

### Phase 3 — Persistence and recovery

- Upload immutable JPEG objects to Supabase.
- Persist storage metadata and job state.
- Implement download-and-reuse behavior.
- Add fallback resolution.

**Exit criterion:** restarting the worker after storage does not trigger another generation.

### Phase 4 — X media handoff

- Implement the v2 X media uploader.
- Persist media ID and expiry.
- Re-upload stored images when media IDs expire.
- Return `ImageResult` to the separate posting service.

**Exit criterion:** an X upload retry never causes a second OpenAI generation.

### Phase 5 — Benchmark and controlled rollout

- Run the prompt/latency benchmark.
- Add dashboards and alerts.
- Enable image generation for one match at a time.
- Review every output during the initial rollout.
- Expand only after latency, failure and visual-acceptance thresholds are understood.

**Exit criterion:** measured p95 latency and fallback rate are acceptable for the desired live-posting experience.

## 19. Definition of done

The image flow is complete when:

- every confirmed event has a stable, unique image job;
- the normal path creates one `gpt-image-2` low-quality landscape JPEG;
- factual text is added only by the deterministic Sharp overlay;
- every final JPEG is valid and below 4.8 MB;
- the image is stored at an immutable Supabase path before X upload;
- retries reuse stored bytes instead of regenerating;
- a valid X media ID and expiry are persisted and returned;
- timeouts, moderation failures and provider outages use a safe fallback;
- secrets and base64 payloads do not appear in logs;
- cost, latency, fallback rate and visual quality are observable.

## 20. Official documentation

- [OpenAI Image Generation Guide](https://developers.openai.com/api/docs/guides/image-generation)
- [GPT Image 2 model](https://developers.openai.com/api/docs/models/gpt-image-2)
- [Supabase standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [X media overview](https://docs.x.com/x-api/media/introduction)
- [X v2 media upload](https://docs.x.com/x-api/media/upload-media)
