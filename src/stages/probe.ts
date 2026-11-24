// Stage 1: metadata only. Runs before any full download or model call.
import { exec } from "../exec.ts";
import type { Config } from "../config.ts";
import type { MediaInfo, Reason, Streams } from "../types.ts";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}
export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; size?: string };
}

export async function ffprobe(input: string, signal?: AbortSignal): Promise<FfprobeOutput> {
  const remote = /^https:/i.test(input);
  const { stdout } = await exec(
    "ffprobe",
    [
      "-v", "error",
      ...(remote ? ["-protocol_whitelist", "https,tls,tcp"] : []),
      "-print_format", "json",
      "-show_format", "-show_streams",
      input,
    ],
    { timeoutMs: 30_000, signal },
  );
  return JSON.parse(stdout) as FfprobeOutput;
}

const parseRate = (r?: string): number => {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  return d ? n / d : n || 0;
};

/** Rotation in the "rotate tag" convention, normalised to 0/90/180/270. */
export function rotationOf(s: FfprobeStream): number {
  const dm = s.side_data_list?.find((d) => typeof d.rotation === "number");
  // A display matrix rotation of -90 means the same as rotate=90.
  const raw = dm ? -(dm.rotation as number) : Number(s.tags?.rotate ?? 0);
  const r = Math.round(raw / 90) * 90;
  return ((r % 360) + 360) % 360;
}

const COMMON_RATIOS: Array<[string, number]> = [
  ["9:16", 9 / 16], ["3:4", 3 / 4], ["4:5", 4 / 5], ["2:3", 2 / 3], ["1:1", 1],
  ["16:9", 16 / 9], ["4:3", 4 / 3], ["5:4", 5 / 4], ["3:2", 3 / 2], ["21:9", 21 / 9],
  ["9:19.5", 9 / 19.5], ["9:20", 9 / 20],
];

export function aspectRatio(w: number, h: number): string {
  const r = w / h;
  const near = COMMON_RATIOS.find(([, v]) => Math.abs(v - r) / v < 0.02);
  return near ? near[0] : `${r.toFixed(2)}:1`;
}

export function orientationOf(w: number, h: number): MediaInfo["orientation"] {
  const r = w / h;
  if (r > 1.05) return "landscape";
  if (r < 0.95) return "portrait";
  return "square";
}

export interface ProbeOutcome {
  media: MediaInfo | null;
  streams: Streams;
  reasons: Reason[];
}

/** Turn ffprobe output into media info plus any stage-1 reasons. Pure; unit-tested. */
export function evaluateProbe(p: FfprobeOutput, cfg: Config, sizeBytes: number | null): ProbeOutcome {
  const reasons: Reason[] = [];
  const streams = p.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const outStreams: Streams = { hasVideo: !!video, hasAudio, hasSpeech: null, hasMusic: null };

  if (!video || !video.width || !video.height) {
    reasons.push({ code: "NO_VIDEO_STREAM", message: "The file has no playable video stream", severity: "reject" });
    return { media: null, streams: { ...outStreams, hasVideo: false }, reasons };
  }

  const rotation = rotationOf(video);
  const swap = rotation === 90 || rotation === 270;
  const width = swap ? video.height : video.width;
  const height = swap ? video.width : video.height;
  const durationSec = Number(p.format?.duration ?? video.duration ?? 0);
  const fileSizeBytes = sizeBytes ?? Number(p.format?.size ?? 0);
  const container = p.format?.format_name ?? "unknown";

  const media: MediaInfo = {
    orientation: orientationOf(width, height),
    aspectRatio: aspectRatio(width, height),
    width,
    height,
    rotation,
    fps: Math.round(parseRate(video.avg_frame_rate || video.r_frame_rate) * 100) / 100,
    codec: video.codec_name ?? "unknown",
    container,
    durationSec: Math.round(durationSec * 10) / 10,
    fileSizeMb: Math.round((fileSizeBytes / 1_048_576) * 10) / 10,
  };

  const containerOk = container.split(",").some((c) => cfg.allowedContainers.includes(c));
  if (!containerOk || !cfg.allowedVideoCodecs.includes(media.codec)) {
    reasons.push({
      code: "UNSUPPORTED_FORMAT",
      message: `Format ${container}/${media.codec} is not supported; use MP4, MOV or WebM with H.264, H.265 or VP9`,
      severity: "reject",
    });
  }
  if (media.fileSizeMb > cfg.maxFileSizeMb) {
    reasons.push({ code: "FILE_TOO_LARGE", message: `File is ${media.fileSizeMb} MB; the limit is ${cfg.maxFileSizeMb} MB`, severity: "reject" });
  }
  if (durationSec < cfg.minDurationSec) {
    reasons.push({ code: "TOO_SHORT", message: `Video is ${media.durationSec} s; the minimum is ${cfg.minDurationSec} s`, severity: "reject" });
  } else if (durationSec > cfg.maxDurationSec) {
    reasons.push({ code: "TOO_LONG", message: `Video is ${fmtDuration(durationSec)}; the limit is ${fmtDuration(cfg.maxDurationSec)}`, severity: "review" });
  }
  if (Math.min(width, height) < cfg.minShortEdgePx) {
    reasons.push({ code: "LOW_RESOLUTION", message: `Video is ${width}×${height}; the shorter edge must be at least ${cfg.minShortEdgePx} px`, severity: "reject" });
  }
  if (media.orientation !== "portrait") {
    reasons.push({ code: "LANDSCAPE", message: `Video is ${media.orientation} (${media.aspectRatio}); the feed needs portrait video`, severity: "reject" });
  }
  return { media, streams: outStreams, reasons };
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}
