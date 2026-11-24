export type Decision = "approve" | "reject" | "review";
export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type ReasonCode =
  | "INVALID_URL"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "NO_VIDEO_STREAM"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "LOW_RESOLUTION"
  | "LANDSCAPE"
  | "SLIDESHOW"
  | "TALKING_HEAD"
  | "TOO_FEW_ROOMS"
  | "LOW_QUALITY"
  | "CONTACT_INFO"
  | "WATERMARK"
  | "UNSAFE_CONTENT"
  | "ANALYSIS_FAILED";

export interface Reason {
  code: ReasonCode;
  message: string;
  /** reject = blocks the video; review = sends it to a person. */
  severity: "reject" | "review";
}

export interface MediaInfo {
  orientation: "portrait" | "landscape" | "square";
  aspectRatio: string;
  /** Display width/height, i.e. after the rotation tag is applied. */
  width: number;
  height: number;
  rotation: number;
  fps: number;
  codec: string;
  container: string;
  durationSec: number;
  fileSizeMb: number;
}

export interface Streams {
  hasVideo: boolean;
  hasAudio: boolean;
  /** null when audio was not analysed (no audio track, or audio not sent to the model). */
  hasSpeech: boolean | null;
  hasMusic: boolean | null;
}

export interface Quality {
  blur: number;
  brightness: number;
  shake: number;
  blackFrameRatio: number;
}

export interface Room {
  type: string;
  confidence: number;
  firstSeenSec: number;
  onScreenSec: number;
}

export interface ContentFlags {
  textOverlay: boolean;
  contactInfo: boolean;
  watermark: boolean;
  otherPeople: boolean;
  unsafe: boolean;
  /** Other listings that already used the exact same file. */
  duplicateOfListings: string[];
}

export interface Audit {
  rulesVersion: string;
  model: string | null;
  /** Last stage the video reached: 1 = probe, 2 = local signals, 3 = model, 4 = rules. */
  stageReached: number;
  processingMs: number;
  framesSent: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cached: boolean;
}

export interface CheckResult {
  decision: Decision;
  score: number;
  reasons: Reason[];
  media: MediaInfo | null;
  streams: Streams | null;
  quality: Quality | null;
  rooms: Room[];
  coverage: { distinctRooms: number; interiorRatio: number; exteriorRatio: number } | null;
  slideshow: { isSlideshow: boolean; confidence: number; staticRatio: number } | null;
  talkingHead: { ratio: number; confidence: number } | null;
  contentFlags: ContentFlags | null;
  suggestedCoverSec: number | null;
  audit: Audit;
}

export interface CheckRequest {
  videoUrl: string;
  listingId: string;
  agentId: string;
  market: string;
  callbackUrl?: string;
}

export interface Job {
  jobId: string;
  status: JobStatus;
  request: CheckRequest;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  result?: CheckResult;
  error?: string;
}

/** Signals computed locally with ffmpeg in stage 2. */
export interface LocalSignals {
  quality: Quality;
  /** Share of the video that is frozen (no motion). */
  staticRatio: number;
  /** Share of the audio track that is above the silence threshold; null without audio. */
  audioActiveRatio: number | null;
}

/**
 * A stretch of the video showing one scene (stage 3). The model returns segments
 * rather than per-frame labels, which keeps output tokens low; durations,
 * ratios and room stats are computed from them in code.
 */
export interface Segment {
  startSec: number;
  endSec: number;
  scene: string;
  confidence: number;
}

export interface ModelAnalysis {
  segments: Segment[];
  slideshow: { isSlideshow: boolean; confidence: number };
  flags: Omit<ContentFlags, "duplicateOfListings">;
  suggestedCoverSec: number | null;
  hasSpeech: boolean | null;
  hasMusic: boolean | null;
  framesSent: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}
