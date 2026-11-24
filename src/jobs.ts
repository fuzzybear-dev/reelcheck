import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { isAllowedUrl, safeFetch } from "./fetch.ts";
import { createJobLogger } from "./logger.ts";
import { redactUrl, runCheck } from "./pipeline.ts";
import { store } from "./store.ts";
import type { CheckRequest, CheckResult, Job } from "./types.ts";

type Runner = typeof runCheck;

/** Small in-process queue with a concurrency cap, per-job timeout and retries. */
export function createQueue(cfg: Config, runner: Runner = runCheck) {
  const pending: string[] = [];
  let active = 0;

  function enqueue(request: CheckRequest): Job {
    const now = new Date().toISOString();
    const job: Job = { jobId: randomUUID(), status: "queued", request, createdAt: now, updatedAt: now, attempts: 0, logs: [] };
    store.putJob(job);
    pending.push(job.jobId);
    pump();
    return job;
  }

  function pump() {
    while (active < cfg.concurrency && pending.length) {
      const job = store.getJob(pending.shift()!)!;
      active++;
      process(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function process(job: Job) {
    update(job, { status: "processing" });
    const { log } = createJobLogger(job.jobId, cfg.logFile, job.logs);
    log(`job start: url=${redactUrl(job.request.videoUrl)}`);
    let lastError = "";
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      update(job, { attempts: attempt + 1 });
      if (attempt > 0) log(`job retry ${attempt}/${cfg.maxRetries}`);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("timeout")), cfg.jobTimeoutMs);
      try {
        const result = await runner(job.request, cfg, { signal: ac.signal, log, jobId: job.jobId });
        update(job, { status: "completed", result, error: undefined });
        break;
      } catch (err) {
        lastError = ac.signal.aborted ? `Timed out after ${cfg.jobTimeoutMs} ms` : (err as Error).message;
        log(`job attempt ${attempt + 1} failed: ${lastError}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (job.status !== "completed") {
      // Out of retries: hand the video to a person rather than failing silently.
      update(job, { status: "completed", result: reviewFallback(cfg), error: lastError });
      log("job out of retries: marked for review (ANALYSIS_FAILED)");
    }
    log(`job done: ${job.result?.decision} in ${Date.parse(job.updatedAt) - Date.parse(job.createdAt)} ms`);
    await sendCallback(job, cfg, log);
  }

  return { enqueue, get size() { return pending.length + active; } };
}

function update(job: Job, patch: Partial<Job>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  store.putJob(job);
}

function reviewFallback(cfg: Config): CheckResult {
  return {
    decision: "review",
    score: 0,
    reasons: [{ code: "ANALYSIS_FAILED", message: "Automatic analysis did not finish; a person will review this video", severity: "review" }],
    media: null, streams: null, quality: null, rooms: [], coverage: null, slideshow: null,
    talkingHead: null, contentFlags: null, suggestedCoverSec: null,
    audit: {
      rulesVersion: cfg.rulesVersion, model: null, stageReached: 0, processingMs: 0,
      framesSent: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: false,
    },
  };
}

export function jobView(job: Job) {
  return {
    jobId: job.jobId,
    status: job.status,
    ...(job.result ?? {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

async function sendCallback(job: Job, cfg: Config, log: (m: string) => void) {
  const url = job.request.callbackUrl;
  if (!url || !isAllowedUrl(url, cfg.allowedCallbackHosts)) return;
  log(`callback: POST ${redactUrl(url)}`);
  for (let i = 0; i < 3; i++) {
    try {
      const { res } = await safeFetch(url, cfg.allowedCallbackHosts, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jobView(job)),
        signal: AbortSignal.timeout(10_000),
      }, 0);
      if (res.ok) return;
    } catch {
      // retry below
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  log(`callback to ${new URL(url).host} failed after 3 tries`);
}
