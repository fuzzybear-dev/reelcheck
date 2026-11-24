// Stage 4: pure rules. Combines everything into a score, a decision and reasons.
import type { Config } from "../config.ts";
import type {
  CheckResult, ContentFlags, LocalSignals, MediaInfo, ModelAnalysis, Reason, Room, Segment, Streams,
} from "../types.ts";
import { EXTERIOR_SCENES, INTERIOR_SCENES } from "./model.ts";

/** Interior scenes that do not count as a distinct room for the coverage rule. */
const NOT_A_ROOM = new Set(["hallway", "other_interior", "walk_in_closet"]);
const ROOM_SCENES = new Set<string>([...INTERIOR_SCENES, "balcony"]);
const INTERIOR = new Set<string>(INTERIOR_SCENES);
const EXTERIOR = new Set<string>(EXTERIOR_SCENES);

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const len = (s: Segment) => s.endSec - s.startSec;

export interface DecideInput {
  media: MediaInfo | null;
  streams: Streams | null;
  /** Reasons already raised by earlier stages. */
  reasons: Reason[];
  signals: LocalSignals | null;
  model: ModelAnalysis | null;
  duplicateOfListings: string[];
}

export function summariseRooms(segments: Segment[]): Room[] {
  const byType = new Map<string, { first: number; secs: number; confSecs: number }>();
  for (const s of segments) {
    if (!ROOM_SCENES.has(s.scene)) continue;
    const r = byType.get(s.scene) ?? { first: s.startSec, secs: 0, confSecs: 0 };
    r.first = Math.min(r.first, s.startSec);
    r.secs += len(s);
    r.confSecs += len(s) * s.confidence;
    byType.set(s.scene, r);
  }
  return [...byType.entries()]
    .map(([type, r]) => ({
      type,
      confidence: round(r.secs ? r.confSecs / r.secs : 0),
      firstSeenSec: Math.round(r.first),
      onScreenSec: Math.round(r.secs),
    }))
    .sort((a, b) => a.firstSeenSec - b.firstSeenSec);
}

export function countDistinctRooms(rooms: Room[], cfg: Config): number {
  return rooms.filter(
    (r) => !NOT_A_ROOM.has(r.type) && r.onScreenSec >= cfg.roomMinOnScreenSec && r.confidence >= cfg.roomMinConfidence,
  ).length;
}

const secondsWhere = (segments: Segment[], pred: (scene: string) => boolean) =>
  segments.filter((s) => pred(s.scene)).reduce((a, s) => a + len(s), 0);

/**
 * Probability-like slideshow score from both sources: the local frozen-frame
 * ratio (catches plain stills) and the model's judgement (catches pan/zoom).
 */
export function slideshowScore(staticRatio: number, model: ModelAnalysis | null): number {
  const fromModel = model ? (model.slideshow.isSlideshow ? model.slideshow.confidence : 1 - model.slideshow.confidence) : 0;
  return clamp01(Math.max(staticRatio, fromModel));
}

export function decide(input: DecideInput, cfg: Config): Omit<CheckResult, "audit"> {
  const reasons = [...input.reasons];
  const { media, signals, model } = input;
  const duration = media?.durationSec || 1;

  // --- derived measurements ---
  const rooms = model ? summariseRooms(model.segments) : [];
  const distinctRooms = countDistinctRooms(rooms, cfg);
  const interiorRatio = model ? round(clamp01(secondsWhere(model.segments, (s) => INTERIOR.has(s)) / duration)) : 0;
  const exteriorRatio = model ? round(clamp01(secondsWhere(model.segments, (s) => EXTERIOR.has(s)) / duration)) : 0;

  const thSegs = model?.segments.filter((s) => s.scene === "talking_head") ?? [];
  const thSecs = thSegs.reduce((a, s) => a + len(s), 0);
  const talkingHeadRatio = round(clamp01(thSecs / duration));
  const talkingHeadConfidence = model
    ? round(thSecs ? thSegs.reduce((a, s) => a + len(s) * s.confidence, 0) / thSecs
      : model.segments.reduce((a, s) => a + len(s) * s.confidence, 0) / Math.max(1, secondsWhere(model.segments, () => true)))
    : 0;

  const staticRatio = signals?.staticRatio ?? 0;
  const pSlide = signals || model ? slideshowScore(staticRatio, model) : 0;
  const isSlideshow = pSlide >= 0.5;

  const flags: ContentFlags | null = model
    ? { ...model.flags, duplicateOfListings: input.duplicateOfListings }
    : input.duplicateOfListings.length
      ? { textOverlay: false, contactInfo: false, watermark: false, otherPeople: false, unsafe: false, duplicateOfListings: input.duplicateOfListings }
      : null;

  // --- rules that need stage 2 / stage 3 output ---
  const add = (r: Reason) => {
    if (!reasons.some((x) => x.code === r.code)) reasons.push(r);
  };
  if (signals) {
    const q = signals.quality;
    if (q.blackFrameRatio > cfg.maxBlackFrameRatio)
      add({ code: "LOW_QUALITY", message: `${Math.round(q.blackFrameRatio * 100)}% of the video is black`, severity: "reject" });
    if (q.brightness < cfg.minBrightness)
      add({ code: "LOW_QUALITY", message: "Video is too dark", severity: "review" });
    if (q.blur > cfg.maxBlur)
      add({ code: "LOW_QUALITY", message: "Video is blurry", severity: "review" });
  }
  if (signals || model) {
    if (pSlide >= cfg.slideshowRejectConfidence)
      add({ code: "SLIDESHOW", message: "Video looks like a slideshow of still photos, not a walkthrough", severity: "reject" });
    else if (pSlide >= cfg.slideshowReviewConfidence)
      add({ code: "SLIDESHOW", message: "Video may be a slideshow of still photos", severity: "review" });
  }
  if (model) {
    if (talkingHeadRatio >= cfg.maxTalkingHeadRatio)
      add({
        code: "TALKING_HEAD",
        message: `${Math.round(talkingHeadRatio * 100)}% of the video is someone talking to camera; the limit is ${Math.round(cfg.maxTalkingHeadRatio * 100)}%`,
        severity: "reject",
      });
    if (distinctRooms < cfg.minDistinctRooms)
      add({
        code: "TOO_FEW_ROOMS",
        message: `Video shows ${distinctRooms} distinct room${distinctRooms === 1 ? "" : "s"}; at least ${cfg.minDistinctRooms} are needed`,
        severity: "reject",
      });
    const flagReason = { contactInfo: "CONTACT_INFO", watermark: "WATERMARK", unsafe: "UNSAFE_CONTENT" } as const;
    const flagMsg = { contactInfo: "Video shows contact details", watermark: "Video shows another portal's watermark or logo", unsafe: "Video may contain unsafe content" };
    for (const key of Object.keys(flagReason) as Array<keyof typeof flagReason>) {
      if (model.flags[key] && cfg.contentFlagsReview.includes(key))
        add({ code: flagReason[key], message: flagMsg[key], severity: "review" });
    }
  }

  // --- score (0-100) ---
  // coverage 35 · interior share 15 · picture quality 25 · not a slideshow 15 · not a talking head 10
  let score = 0;
  if (model && signals) {
    const q = signals.quality;
    score =
      (Math.min(distinctRooms, 4) / 4) * 35 +
      interiorRatio * 15 +
      ((1 - q.blur) * 10 + clamp01(1 - Math.abs(q.brightness - 0.55) / 0.55) * 8 + (1 - q.shake) * 7) +
      (1 - pSlide) * 15 +
      (1 - clamp01(talkingHeadRatio / 0.5)) * 10;
  }
  score = Math.round(score);

  const hasReject = reasons.some((r) => r.severity === "reject");
  if (!hasReject && !reasons.length && score < cfg.approveMinScore)
    reasons.push({ code: "LOW_QUALITY", message: `Overall score ${score} is below ${cfg.approveMinScore}`, severity: "review" });
  const decision = hasReject ? "reject" : reasons.length ? "review" : "approve";

  return {
    decision,
    score,
    reasons,
    media,
    streams: input.streams && {
      ...input.streams,
      hasSpeech: model?.hasSpeech ?? null,
      hasMusic: model?.hasMusic ?? null,
    },
    quality: signals?.quality ?? null,
    rooms,
    coverage: model ? { distinctRooms, interiorRatio, exteriorRatio } : null,
    slideshow: signals || model ? { isSlideshow, confidence: round(isSlideshow ? pSlide : 1 - pSlide), staticRatio: round(staticRatio) } : null,
    talkingHead: model ? { ratio: talkingHeadRatio, confidence: talkingHeadConfidence } : null,
    contentFlags: flags,
    suggestedCoverSec: model?.suggestedCoverSec ?? null,
  };
}
