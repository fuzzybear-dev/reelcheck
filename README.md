# ReelCheck

Automated quality check for property listing videos before they go into a vertical, swipeable
video feed. Give it a video URL and it returns orientation, media info, rooms shown, picture quality,
slideshow and talking-head detection, content flags, a suggested cover frame, a 0–100 score, and a
verdict: **approve**, **reject** or **review**, with coded reasons that can be shown to the uploader.

Cheap checks run first and the AI model runs last, so obviously unsuitable uploads (landscape,
too short, low resolution, still-photo slideshows, mostly black) never reach the paid step.

## Requirements

- Node.js ≥ 23.6 (runs the TypeScript sources directly; no build step, no npm dependencies)
- `ffmpeg` and `ffprobe` on `PATH` (`brew install ffmpeg`, `apt install ffmpeg`)
- A [Gemini API key](https://aistudio.google.com/apikey) for stage 3

## Quick start

```sh
cp .env.example .env        # then fill in GEMINI_API_KEY and ALLOWED_VIDEO_HOSTS
npm test                    # unit tests (no ffmpeg or API key needed)
npm run check -- clip.mp4   # check one local file and print the JSON result
npm start                   # start the HTTP API on :8080
```

## API

The API is asynchronous because a check takes seconds to minutes.

```sh
curl -X POST localhost:8080/v1/video-checks \
  -d '{"videoUrl":"https://uploads.example.com/v.mp4","callbackUrl":"https://hooks.example.com/reelcheck"}'
# 202 {"jobId":"…","status":"queued"}

curl localhost:8080/v1/video-checks/<jobId>
# {"jobId":"…","status":"completed","decision":"approve","score":86,"reasons":[],"media":{…},"rooms":[…],…}

curl localhost:8080/v1/video-checks/<jobId>/logs
# {"jobId":"…","status":"completed","attempts":1,"logs":["2026-11-24T09:12:03.120Z [<jobId>] +842ms stage 1: 576x1024 portrait 9:16 …", …]}
```

Each job logs every stage (measurements, Gemini attempts, tokens, cost, decision) to stdout, to
`logs/reelcheck.log` (`LOG_FILE`), and to the `/logs` endpoint above. Query strings are stripped from
logged URLs, since signed URLs carry credentials.

Only `videoUrl` is required. If `callbackUrl` is given (and its host is in `ALLOWED_CALLBACK_HOSTS`), the same body is POSTed there
when the job finishes. Reason codes: `INVALID_URL`, `FILE_TOO_LARGE`, `UNSUPPORTED_FORMAT`,
`NO_VIDEO_STREAM`, `TOO_SHORT`, `TOO_LONG`, `LOW_RESOLUTION`, `LANDSCAPE`, `SLIDESHOW`,
`TALKING_HEAD`, `TOO_FEW_ROOMS`, `LOW_QUALITY`, `CONTACT_INFO`, `WATERMARK`, `UNSAFE_CONTENT`,
`ANALYSIS_FAILED`. See `src/types.ts` for the full result shape.

## How it works

| Stage | File | Cost | Can reject on |
|---|---|---|---|
| 1 probe | `src/stages/probe.ts` | HEAD + remote ffprobe, no download | URL not allowlisted, size, format/codec, duration, resolution, not portrait |
| 2 signals | `src/stages/signals.ts` | download + SHA-256, one ffmpeg pass at 2 fps / 480 px | ≥85 % frozen frames (slideshow), ≥50 % black; same file seen before → cached result |
| 3 model | `src/stages/model.ts` | low-fps H.264 proxy → Gemini, structured JSON output | — (labels only) |
| 4 decide | `src/stages/decide.ts` | pure rules | talking head ≥30 %, fewer than 2 distinct rooms, slideshow, quality |

The model returns **scene segments** (`startSec`, `endSec`, `scene`, `confidence`), not final numbers.
Rooms, on-screen seconds, interior/exterior share and talking-head ratio are computed in code, which
keeps output tokens low and lets the rules be unit-tested without the model.

Default acceptance rule: portrait, at least 2 distinct interior rooms, not a slideshow, talking head
under 30 % of the video (so a short agent intro is fine).

## Configuration

All limits and thresholds are in `src/config.ts` and can be overridden by environment variable;
`.env.example` lists the common ones.

- `ALLOWED_VIDEO_HOSTS`: hosts videos may be fetched from. **Empty means every URL is rejected**, so the
  service never fetches arbitrary URLs. Redirects are followed only while they stay on the allowlist.
- `ALLOWED_CALLBACK_HOSTS`: hosts webhooks may be sent to. Empty disables callbacks.
- `GEMINI_MODEL`, `GEMINI_PRICE_*_PER_M`: model and prices used for the cost in `audit`.
  Prices change; check Google's pricing page.
- `GEMINI_ATTEMPTS`, `GEMINI_ATTEMPT_TIMEOUT_MS`, `GEMINI_FALLBACK_MODEL`: each model call is capped
  (default 35 s) and retried on 429/5xx/timeout (default 3 attempts). If a fallback model is set, the
  last attempt uses it; `audit.model` records which model answered.
- `GEMINI_SEND_AUDIO=1`: also send a mono audio track so `hasSpeech`/`hasMusic` are filled
  (they are `null` otherwise). Adds roughly 25 tokens per second.
- `CONTENT_FLAGS_REVIEW`: which content flags send a video to review. Default `unsafe` only; the
  others are reported but do not change the verdict until their accuracy has been measured.

## Behaviour notes

- **Too long** (over 180 s): analysed with a 60-frame cap, then sent to `review` with `TOO_LONG`.
- **Width/height** are display dimensions after the rotation tag; `rotation` uses the rotate-tag convention.
- **Distinct rooms** exclude hallway, walk-in closet and "other interior", and rooms on screen under 2 s
  or below 0.6 confidence. Balconies count.
- **Failures and timeouts**: 120 s per attempt, 2 retries, then the job completes as `review` with
  `ANALYSIS_FAILED`. Model failures are never cached.
- **Duplicates**: if the exact same file was submitted before, the earlier job IDs are listed in
  `contentFlags.duplicateOfJobs` and the cached result is returned at no model cost.
- **Rate limit**: `RATE_LIMIT_PER_HOUR` checks per client IP (default 60). Behind a reverse proxy,
  set `TRUST_PROXY=1` so the limit uses `X-Forwarded-For`.

## Limitations

- State (jobs, cache, rate limits) is in memory, so run a single instance or replace `src/store.ts`
  with Redis or a database.
- Blur, brightness and shake scores are heuristics that need calibrating on real uploads. Shake is
  approximated from frame-difference jitter, because common ffmpeg builds lack vidstab.
- Gemini request options (`mediaResolution`, `thinkingConfig`, `videoMetadata.fps`) should be checked
  against the current API version; `audit` records actual token usage so cost can be measured.
- Not yet implemented: Gemini Batch API mode, near-duplicate detection, metrics.

## License

[MIT](LICENSE)
