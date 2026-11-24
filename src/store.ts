// In-memory state. Fine for one instance; swap for Redis/Postgres behind the
// same functions before running more than one replica.
import type { CheckResult, Job } from "./types.ts";

const jobs = new Map<string, Job>();
const resultsByHash = new Map<string, CheckResult>();
const jobsByHash = new Map<string, string[]>();
const MAX_JOBS_PER_HASH = 20;
const hits = new Map<string, number[]>();

export const store = {
  getJob: (id: string) => jobs.get(id),
  putJob: (job: Job) => void jobs.set(job.jobId, job),

  getCached: (key: string) => resultsByHash.get(key),
  putCached: (key: string, r: CheckResult) => void resultsByHash.set(key, r),

  /** Record that a job submitted this file; return the earlier jobs that did (oldest first). */
  noteFile(hash: string, jobId: string): string[] {
    const earlier = (jobsByHash.get(hash) ?? []).filter((j) => j !== jobId);
    jobsByHash.set(hash, [...earlier, jobId].slice(-MAX_JOBS_PER_HASH));
    return earlier;
  },

  /** Sliding-window rate limit. Returns false if the key is over its limit. */
  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  },

  _reset() {
    jobs.clear(); resultsByHash.clear(); jobsByHash.clear(); hits.clear();
  },
};
