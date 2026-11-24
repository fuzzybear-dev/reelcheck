// Stage 3: the only paid step. Builds a small proxy and asks Gemini to label it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../exec.ts";
import type { Config } from "../config.ts";
import type { ModelAnalysis, Segment } from "../types.ts";

export const INTERIOR_SCENES = [
  "living_room", "bedroom", "bathroom", "kitchen", "dining_room", "study",
  "laundry", "hallway", "walk_in_closet", "other_interior",
] as const;
export const EXTERIOR_SCENES = [
  "balcony", "building_exterior", "facilities", "view", "street",
] as const;
export const OTHER_SCENES = ["talking_head", "title_card", "black_or_blank", "other"] as const;
export const ALL_SCENES = [...INTERIOR_SCENES, ...EXTERIOR_SCENES, ...OTHER_SCENES];

/** Frames per second to sample so that no video sends more than maxFrames. */
export function sampleFps(durationSec: number, cfg: Config): number {
  const fps = Math.min(cfg.frameFps, cfg.maxFrames / Math.max(durationSec, 1));
  return Math.round(fps * 1000) / 1000;
}

/**
 * Lightweight proxy: low fps, ~448 px tall, H.264 veryfast. Audio is dropped
 * unless sendAudio is on (then mono 32 kbps, for speech/music detection).
 * Timestamps are preserved, so the model's seconds match the original.
 */
export async function buildProxy(
  file: string,
  workDir: string,
  fps: number,
  withAudio: boolean,
  cfg: Config,
  signal?: AbortSignal,
): Promise<string> {
  const out = join(workDir, "proxy.mp4");
  await exec(
    "ffmpeg",
    [
      "-hide_banner", "-nostats", "-y", "-i", file,
      "-t", String(cfg.maxDurationSec * 2), // hard stop for pathological files
      "-map", "0:v:0", ...(withAudio ? ["-map", "0:a:0"] : []),
      "-vf", `fps=${fps},scale=-2:${cfg.frameHeightPx}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
      ...(withAudio ? ["-c:a", "aac", "-ac", "1", "-b:a", "32k"] : ["-an"]),
      "-movflags", "+faststart", out,
    ],
    { timeoutMs: 90_000, signal },
  );
  return out;
}

const PROMPT = (durationSec: number, withAudio: boolean) => `You are checking an estate agent's property listing video before it is shown in a vertical mobile video feed.
The video is ${durationSec} seconds long and has been downsampled to a few frames per second.

Return JSON only.

segments: split the whole timeline (0 to ${durationSec} s) into consecutive stretches that each show one scene. Merge adjacent frames with the same scene. Scenes:
- interior rooms: ${INTERIOR_SCENES.join(", ")}
- outside the unit: ${EXTERIOR_SCENES.join(", ")} (facilities = pool, gym, lobby, playground)
- talking_head: a person speaking to the camera and filling much of the frame, the property is only a backdrop
- title_card: text, logo or graphic screens
- black_or_blank, other
confidence: 0-1, how sure you are of the scene label.

slideshow: true if the video is mostly still photographs (including pan/zoom over stills) rather than continuous camera footage of a walkthrough.

flags (true only if clearly visible anywhere):
- textOverlay: any burned-in text
- contactInfo: phone numbers, emails, URLs, WhatsApp/WeChat/Line IDs or QR codes
- watermark: logos or watermarks of property portals or agencies
- otherPeople: identifiable people other than the presenting agent, e.g. tenants or children
- unsafe: nudity, violence, weapons, drugs or hateful symbols

suggestedCoverSec: the second with the most attractive, sharp, well-lit interior shot for a thumbnail.
${withAudio ? "hasSpeech / hasMusic: whether the audio contains speech / music." : "hasSpeech / hasMusic: return null (no audio was sent)."}`;

const SEGMENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    startSec: { type: "NUMBER" },
    endSec: { type: "NUMBER" },
    scene: { type: "STRING", enum: ALL_SCENES },
    confidence: { type: "NUMBER" },
  },
  required: ["startSec", "endSec", "scene", "confidence"],
};
const BOOL = { type: "BOOLEAN" };
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    segments: { type: "ARRAY", items: SEGMENT_SCHEMA },
    slideshow: { type: "OBJECT", properties: { isSlideshow: BOOL, confidence: { type: "NUMBER" } }, required: ["isSlideshow", "confidence"] },
    flags: {
      type: "OBJECT",
      properties: { textOverlay: BOOL, contactInfo: BOOL, watermark: BOOL, otherPeople: BOOL, unsafe: BOOL },
      required: ["textOverlay", "contactInfo", "watermark", "otherPeople", "unsafe"],
    },
    suggestedCoverSec: { type: "NUMBER" },
    hasSpeech: { type: "BOOLEAN", nullable: true },
    hasMusic: { type: "BOOLEAN", nullable: true },
  },
  required: ["segments", "slideshow", "flags", "suggestedCoverSec", "hasSpeech", "hasMusic"],
};

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: Array<{ modality: string; tokenCount: number }>;
}

export function costOf(usage: GeminiUsage, cfg: Config): { input: number; output: number; usd: number } {
  const input = usage.promptTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const audio = usage.promptTokensDetails?.find((d) => d.modality === "AUDIO")?.tokenCount ?? 0;
  const usd =
    ((input - audio) * cfg.priceInputPerM + audio * cfg.priceAudioInputPerM + output * cfg.priceOutputPerM) / 1e6;
  return { input, output, usd: Math.round(usd * 1e6) / 1e6 };
}

export async function analyseWithModel(
  proxyPath: string,
  durationSec: number,
  fps: number,
  withAudio: boolean,
  cfg: Config,
  signal?: AbortSignal,
): Promise<ModelAnalysis> {
  if (!cfg.geminiApiKey) throw new Error("GEMINI_API_KEY is not set");
  const video = await readFile(proxyPath);

  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0,
    mediaResolution: "MEDIA_RESOLUTION_LOW",
    maxOutputTokens: 2048,
  };
  if (cfg.geminiThinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: cfg.geminiThinkingLevel };

  const body = {
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "video/mp4", data: video.toString("base64") }, videoMetadata: { fps } },
        { text: PROMPT(durationSec, withAudio) },
      ],
    }],
    generationConfig,
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiApiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
    usageMetadata?: GeminiUsage;
  };
  const text = json.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (!text) throw new Error(`Gemini returned no content (finishReason=${json.candidates?.[0]?.finishReason})`);

  const parsed = JSON.parse(text);
  const cost = costOf(json.usageMetadata ?? {}, cfg);
  return {
    segments: normaliseSegments(parsed.segments ?? [], durationSec),
    slideshow: { isSlideshow: !!parsed.slideshow?.isSlideshow, confidence: clamp01(parsed.slideshow?.confidence) },
    flags: {
      textOverlay: !!parsed.flags?.textOverlay,
      contactInfo: !!parsed.flags?.contactInfo,
      watermark: !!parsed.flags?.watermark,
      otherPeople: !!parsed.flags?.otherPeople,
      unsafe: !!parsed.flags?.unsafe,
    },
    suggestedCoverSec: Number.isFinite(parsed.suggestedCoverSec)
      ? Math.min(Math.max(0, Math.round(parsed.suggestedCoverSec)), Math.floor(durationSec))
      : null,
    hasSpeech: withAudio ? (parsed.hasSpeech ?? null) : null,
    hasMusic: withAudio ? (parsed.hasMusic ?? null) : null,
    framesSent: Math.ceil(durationSec * fps),
    inputTokens: cost.input,
    outputTokens: cost.output,
    costUsd: cost.usd,
    model: cfg.geminiModel,
  };
}

function clamp01(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** Clip to the video, drop junk, sort, and remove overlaps. */
export function normaliseSegments(raw: Segment[], durationSec: number): Segment[] {
  const valid = raw
    .map((s) => ({
      startSec: Math.max(0, Number(s.startSec)),
      endSec: Math.min(durationSec, Number(s.endSec)),
      scene: ALL_SCENES.includes(s.scene as never) ? s.scene : "other",
      confidence: clamp01(s.confidence),
    }))
    .filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const out: Segment[] = [];
  for (const s of valid) {
    const prev = out[out.length - 1];
    if (prev && s.startSec < prev.endSec) s.startSec = prev.endSec;
    if (s.endSec > s.startSec) out.push(s);
  }
  return out;
}
