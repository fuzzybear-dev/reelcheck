// Stage 2: free local signals from one ffmpeg pass over a low-res, low-fps decode.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../exec.ts";
import type { Config } from "../config.ts";
import type { LocalSignals } from "../types.ts";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export async function computeSignals(
  file: string,
  workDir: string,
  durationSec: number,
  hasAudio: boolean,
  cfg: Config,
  signal?: AbortSignal,
): Promise<LocalSignals> {
  const metaFile = join(workDir, "frames-meta.txt");
  const vf = [
    `fps=${cfg.analysisFps}`,
    `scale=${cfg.analysisWidth}:-2`,
    "format=yuv420p",
    "signalstats",
    "blurdetect",
    "blackdetect=d=0.5:pix_th=0.10",
    "freezedetect=n=-50dB:d=2",
    `metadata=mode=print:file=${metaFile}`,
  ].join(",");

  const video = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", file, "-map", "0:v:0", "-vf", vf, "-f", "null", "-"],
    { timeoutMs: 90_000, signal },
  );
  const frames = parseFrameMetadata(await readFile(metaFile, "utf8"));
  const black = sumIntervals(video.stderr, "black_start", "black_end", durationSec);
  const frozen = sumIntervals(video.stderr, "freeze_start", "freeze_end", durationSec);

  let audioActiveRatio: number | null = null;
  if (hasAudio) {
    const audio = await exec(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", `silencedetect=noise=${cfg.silenceNoiseDb}dB:d=1`, "-f", "null", "-"],
      { timeoutMs: 60_000, signal },
    );
    const silent = sumIntervals(audio.stderr, "silence_start", "silence_end", durationSec);
    audioActiveRatio = round(clamp01(1 - silent / durationSec));
  }

  return {
    quality: {
      blur: blurScore(frames.map((f) => f.blur)),
      brightness: brightnessScore(frames.map((f) => f.yavg)),
      shake: shakeScore(frames.map((f) => f.ydif)),
      blackFrameRatio: round(clamp01(black / durationSec)),
    },
    staticRatio: round(clamp01(frozen / durationSec)),
    audioActiveRatio,
  };
}

export interface FrameStat {
  t: number;
  yavg: number;
  ydif: number;
  blur: number;
}

/** Parse the output of ffmpeg's metadata=mode=print filter. */
export function parseFrameMetadata(text: string): FrameStat[] {
  const out: FrameStat[] = [];
  let cur: FrameStat | null = null;
  for (const line of text.split("\n")) {
    const frame = line.match(/^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/);
    if (frame) {
      if (cur) out.push(cur);
      cur = { t: Number(frame[1]), yavg: NaN, ydif: NaN, blur: NaN };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^lavfi\.([\w.]+)=(\S+)/);
    if (!kv) continue;
    const v = Number(kv[2]);
    if (kv[1] === "signalstats.YAVG") cur.yavg = v;
    else if (kv[1] === "signalstats.YDIF") cur.ydif = v;
    else if (kv[1] === "blur") cur.blur = v;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Total seconds covered by intervals that ffmpeg logs as "<start>: X" ... "<end>: Y".
 * An interval still open at end of file runs to the end of the video.
 */
export function sumIntervals(log: string, startKey: string, endKey: string, durationSec: number): number {
  const re = new RegExp(`(${startKey}|${endKey})[:=]\\s*(-?[\\d.]+)`, "g");
  let total = 0;
  let open: number | null = null;
  for (const m of log.matchAll(re)) {
    const t = Number(m[2]);
    if (m[1] === startKey) open = Math.max(0, t);
    else if (open !== null) {
      total += Math.max(0, t - open);
      open = null;
    }
  }
  if (open !== null) total += Math.max(0, durationSec - open);
  return Math.min(total, durationSec);
}

const finite = (xs: number[]) => xs.filter(Number.isFinite);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The three scores below are heuristics: the mapping constants need calibrating
// on a labelled sample of real uploads before they drive auto-rejects.

/** blurdetect reports mean edge width; ~2-4 is sharp, 10+ is very soft. */
export function blurScore(values: number[]): number {
  return round(clamp01((median(finite(values)) - 3) / 7));
}

/** Mean luma, mapped from limited range (16-235) to 0-1. */
export function brightnessScore(yavg: number[]): number {
  return round(clamp01((mean(finite(yavg)) - 16) / 219));
}

/**
 * Shake proxy without a stabiliser: a smooth walkthrough has steady frame-to-frame
 * change, a shaky one has change that jumps around. Mean absolute second difference
 * of YDIF, scaled.
 */
export function shakeScore(ydif: number[]): number {
  const xs = finite(ydif).slice(1); // first frame has no predecessor
  if (xs.length < 3) return 0;
  const jumps = xs.slice(1).map((v, i) => Math.abs(v - xs[i]));
  return round(clamp01(mean(jumps) / 8));
}
