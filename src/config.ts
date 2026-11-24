// All limits and thresholds live here. Defaults are starting points to tune on real
// uploads; each can be overridden by env var (see .env.example).

const env = process.env;
const num = (name: string, fallback: number): number => {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
};
const list = (name: string, fallback: string[]): string[] =>
  env[name] ? env[name]!.split(",").map((s) => s.trim()).filter(Boolean) : fallback;

export const config = {
  rulesVersion: "2026-11-24",
  port: num("PORT", 8080),

  // --- Stage 1: hard limits ---
  minDurationSec: num("MIN_DURATION_SEC", 10),
  maxDurationSec: num("MAX_DURATION_SEC", 180),
  maxFileSizeMb: num("MAX_FILE_SIZE_MB", 300),
  minShortEdgePx: num("MIN_SHORT_EDGE_PX", 720),
  allowedContainers: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm"],
  allowedVideoCodecs: ["h264", "hevc", "vp9"],
  /** Hosts videos may be fetched from. Empty = reject everything (fail closed). */
  allowedVideoHosts: list("ALLOWED_VIDEO_HOSTS", []),
  /** Hosts callbacks may be POSTed to. Empty = callbacks disabled. */
  allowedCallbackHosts: list("ALLOWED_CALLBACK_HOSTS", []),

  // --- Jobs ---
  jobTimeoutMs: num("JOB_TIMEOUT_MS", 120_000),
  maxRetries: num("MAX_RETRIES", 2),
  concurrency: num("CONCURRENCY", 2),
  rateLimitPerAgentPerHour: num("RATE_LIMIT_AGENT_PER_HOUR", 30),
  rateLimitPerListingPerHour: num("RATE_LIMIT_LISTING_PER_HOUR", 5),

  // --- Stage 2: local signals ---
  analysisFps: 2,
  analysisWidth: 480,
  silenceNoiseDb: -40,

  // --- Stage 3: model ---
  geminiApiKey: env.GEMINI_API_KEY ?? "",
  geminiModel: env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
  /** Thinking off/minimal saves output tokens. Set to "" to omit thinkingConfig. */
  geminiThinkingLevel: env.GEMINI_THINKING_LEVEL ?? "minimal",
  /** USD per 1M tokens. Confirm against Google's pricing page. */
  priceInputPerM: num("GEMINI_PRICE_INPUT_PER_M", 0.1),
  priceAudioInputPerM: num("GEMINI_PRICE_AUDIO_INPUT_PER_M", 0.3),
  priceOutputPerM: num("GEMINI_PRICE_OUTPUT_PER_M", 0.4),
  /** Sending audio enables hasSpeech/hasMusic but adds ~25 tokens/sec. */
  sendAudio: env.GEMINI_SEND_AUDIO === "1",
  frameFps: num("FRAME_FPS", 1),
  maxFrames: num("MAX_FRAMES", 60),
  frameHeightPx: num("FRAME_HEIGHT_PX", 448),

  // --- Stage 4: acceptance rules ---
  minDistinctRooms: num("MIN_DISTINCT_ROOMS", 2),
  roomMinOnScreenSec: 2,
  roomMinConfidence: 0.6,
  maxTalkingHeadRatio: num("MAX_TALKING_HEAD_RATIO", 0.3),
  /** Local static ratio above this rejects before the model is called. */
  slideshowRejectStaticRatio: 0.85,
  slideshowRejectConfidence: 0.8,
  slideshowReviewConfidence: 0.5,
  maxBlackFrameRatio: 0.5,
  minBrightness: 0.12,
  maxBlur: 0.75,
  approveMinScore: 60,
  /**
   * Content flags are reported but not auto-rejected until accuracy is measured.
   * "unsafe" sends the video to review, because publishing it unseen is the worse error.
   */
  contentFlagsReview: list("CONTENT_FLAGS_REVIEW", ["unsafe"]),
};

export type Config = typeof config;
