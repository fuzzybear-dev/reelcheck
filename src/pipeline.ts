// The four-stage cascade. Each stage is cheaper than the next, and a video that
// fails a cheap stage never reaches the paid model call.
//
//   1. probe   URL allowlist, HEAD size, remote ffprobe         (no download)
//   2. signals download + hash, cache lookup, ffmpeg filters   (local CPU)
//   3. model   low-fps proxy -> Gemini                         (paid)
//   4. decide  rules -> score, decision, reasons               (pure)
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { downloadWithHash, headSize, isAllowedUrl } from "./fetch.ts";
import { store } from "./store.ts";
import { ffprobe, evaluateProbe } from "./stages/probe.ts";
import { computeSignals } from "./stages/signals.ts";
import { analyseWithModel, buildProxy, sampleFps } from "./stages/model.ts";
import { decide, type DecideInput } from "./stages/decide.ts";
import type { CheckRequest, CheckResult, ModelAnalysis } from "./types.ts";

export interface RunOptions {
  signal?: AbortSignal;
  /** For local testing: analyse a file on disk and skip URL/HEAD/download. */
  localFile?: string;
  log?: (msg: string) => void;
}

/** Drop the query string, which on signed URLs carries credentials. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "<invalid url>";
  }
}

export async function runCheck(req: CheckRequest, cfg: Config, opts: RunOptions = {}): Promise<CheckResult> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const { signal } = opts;

  const finish = (input: DecideInput, stage: number, model: ModelAnalysis | null, cached = false): CheckResult => {
    const result = buildResult(input, stage, model, cached);
    const why = result.reasons.map((r) => `${r.code}(${r.severity})`).join(", ") || "none";
    log(`decision: ${result.decision} score=${result.score} at stage ${stage}; reasons: ${why}; cost $${result.audit.costUsd}`);
    return result;
  };
  const buildResult = (input: DecideInput, stage: number, model: ModelAnalysis | null, cached: boolean): CheckResult => ({
    ...decide(input, cfg),
    audit: {
      rulesVersion: cfg.rulesVersion,
      model: model?.model ?? null,
      stageReached: stage,
      processingMs: Date.now() - started,
      framesSent: model?.framesSent ?? 0,
      inputTokens: model?.inputTokens ?? 0,
      outputTokens: model?.outputTokens ?? 0,
      costUsd: model?.costUsd ?? 0,
      cached,
    },
  });
  const base = { media: null, streams: null, signals: null, model: null, duplicateSubmissions: 0 };

  // ---- Stage 1: probe ----
  let probeTarget = opts.localFile ?? req.videoUrl;
  let sizeBytes: number | null = null;
  if (!opts.localFile) {
    if (!isAllowedUrl(req.videoUrl, cfg.allowedVideoHosts)) {
      return finish({ ...base, reasons: [{ code: "INVALID_URL", message: "Video URL must be HTTPS on an approved upload host", severity: "reject" }] }, 1, null);
    }
    log(`stage 1: HEAD ${redactUrl(req.videoUrl)}`);
    const head = await headSize(req.videoUrl, cfg.allowedVideoHosts, signal);
    probeTarget = head.finalUrl;
    sizeBytes = head.bytes;
    log(`stage 1: size ${sizeBytes === null ? "unknown" : (sizeBytes / 1_048_576).toFixed(1) + " MB"}${head.finalUrl !== req.videoUrl ? `, redirected to ${redactUrl(head.finalUrl)}` : ""}`);
    if (sizeBytes !== null && sizeBytes > cfg.maxFileSizeMb * 1_048_576) {
      const mb = Math.round(sizeBytes / 104_857.6) / 10;
      return finish({ ...base, reasons: [{ code: "FILE_TOO_LARGE", message: `File is ${mb} MB; the limit is ${cfg.maxFileSizeMb} MB`, severity: "reject" }] }, 1, null);
    }
  }
  log("stage 1: ffprobe");
  const probe = evaluateProbe(await ffprobe(probeTarget, signal), cfg, sizeBytes);
  if (probe.media) {
    const m = probe.media;
    log(`stage 1: ${m.width}x${m.height} ${m.orientation} ${m.aspectRatio} rot=${m.rotation} ${m.codec} ${m.fps}fps ${m.durationSec}s ${m.fileSizeMb}MB audio=${probe.streams.hasAudio}`);
  }
  const stage1 = { ...base, media: probe.media, streams: probe.streams, reasons: probe.reasons };
  if (probe.reasons.some((r) => r.severity === "reject")) return finish(stage1, 1, null);
  const media = probe.media!;

  const workDir = await mkdtemp(join(tmpdir(), "reelcheck-"));
  try {
    // ---- Stage 2: download, dedupe, local signals ----
    let file = opts.localFile;
    if (!file) {
      log("stage 2: download");
      file = join(workDir, "source");
      const dl = await downloadWithHash(probeTarget, file, cfg.maxFileSizeMb * 1_048_576, cfg.allowedVideoHosts, signal);
      log(`stage 2: downloaded ${(dl.bytes / 1_048_576).toFixed(1)} MB sha256=${dl.sha256.slice(0, 12)}…`);
      const cacheKey = `${dl.sha256}:${cfg.rulesVersion}:${cfg.geminiModel}`;
      const duplicates = store.noteFile(dl.sha256);
      const cached = store.getCached(cacheKey);
      if (cached) {
        log(`cache hit: returning ${cached.decision} from an earlier check; file submitted ${duplicates} time(s) before`);
        return {
          ...cached,
          contentFlags: cached.contentFlags && { ...cached.contentFlags, duplicateSubmissions: duplicates },
          audit: { ...cached.audit, cached: true, processingMs: Date.now() - started, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        };
      }
      stage1.duplicateSubmissions = duplicates;
      const result = await stages234(file);
      // Transient model failures must not stick to the file forever.
      if (!result.reasons.some((r) => r.code === "ANALYSIS_FAILED")) store.putCached(cacheKey, result);
      return result;
    }
    return await stages234(file);

    async function stages234(path: string): Promise<CheckResult> {
      log("stage 2: signals");
      const signals = await computeSignals(path, workDir, media.durationSec, probe.streams.hasAudio, cfg, signal);
      const q = signals.quality;
      log(`stage 2: blur=${q.blur} brightness=${q.brightness} shake=${q.shake} black=${q.blackFrameRatio} static=${signals.staticRatio} audioActive=${signals.audioActiveRatio}`);
      const stage2 = { ...stage1, signals };
      const early = decide(stage2, cfg);
      if (early.decision === "reject") return finish(stage2, 2, null);

      // ---- Stage 3: model ----
      let model: ModelAnalysis | null = null;
      try {
        const withAudio = cfg.sendAudio && probe.streams.hasAudio;
        const fps = sampleFps(media.durationSec, cfg);
        log(`stage 3: proxy at ${fps} fps`);
        const proxy = await buildProxy(path, workDir, fps, withAudio, cfg, signal);
        log(`stage 3: proxy ${(statSync(proxy).size / 1024).toFixed(0)} KB, ~${Math.ceil(media.durationSec * fps)} frames, audio=${withAudio}`);
        model = await analyseWithModel(proxy, media.durationSec, fps, withAudio, cfg, signal, log);
        log(`stage 3: ${model.model} answered; tokens in=${model.inputTokens} out=${model.outputTokens} cost=$${model.costUsd}`);
        log(`stage 3: segments ${model.segments.map((s) => `${s.startSec}-${s.endSec}s ${s.scene}(${s.confidence})`).join(" | ")}`);
        const flagsOn = Object.entries(model.flags).filter(([, v]) => v).map(([k]) => k);
        log(`stage 3: slideshow=${model.slideshow.isSlideshow}(${model.slideshow.confidence}) flags=${flagsOn.join(",") || "none"} cover=${model.suggestedCoverSec}s`);
      } catch (err) {
        if (signal?.aborted) throw err;
        log(`stage 3 failed: ${(err as Error).message}`);
        return finish({
          ...stage2,
          reasons: [...stage2.reasons, { code: "ANALYSIS_FAILED", message: "Automatic analysis failed; a person will review this video", severity: "review" }],
        }, 3, null);
      }

      // ---- Stage 4: decide ----
      return finish({ ...stage2, model }, 4, model);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
