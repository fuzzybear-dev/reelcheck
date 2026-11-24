// In-memory state. Fine for one instance; swap for Redis/Postgres behind the
// same functions before running more than one replica.
import type { CheckResult, Job } from "./types.ts";

const jobs = new Map<string, Job>();
const resultsByHash = new Map<string, CheckResult>();
const submissionsByHash = new Map<string, number>();
/** Above this many tracked clients, expired rate-limit entries are swept. */
const MAX_RATE_KEYS = 10_000;
const hits = new Map<string, number[]>();

export const store = {
  getJob: (id: string) => jobs.get(id),
  putJob: (job: Job) => void jobs.set(job.jobId, job),

  getCached: (key: string) => resultsByHash.get(key),
  putCached: (key: string, r: CheckResult) => void resultsByHash.set(key, r),

  /** Record a submission of this file; return how many earlier submissions there were. */
  noteFile(hash: string): number {
    const earlier = submissionsByHash.get(hash) ?? 0;
    submissionsByHash.set(hash, earlier + 1);
    return earlier;
  },

  /** Sliding-window rate limit. Returns false if the key is over its limit. */
  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (hits.size > MAX_RATE_KEYS) {
      for (const [k, ts] of hits) if (!ts.length || now - ts[ts.length - 1] >= windowMs) hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  },

  _rateKeys: () => hits.size,

  _reset() {
    jobs.clear(); resultsByHash.clear(); submissionsByHash.clear(); hits.clear();
  },
};
