// In-memory state. Fine for one instance; swap for Redis/Postgres behind the
// same functions before running more than one replica.
import type { CheckResult, Job } from "./types.ts";

const jobs = new Map<string, Job>();
const resultsByHash = new Map<string, CheckResult>();
const listingsByHash = new Map<string, Set<string>>();
const hits = new Map<string, number[]>();

export const store = {
  getJob: (id: string) => jobs.get(id),
  putJob: (job: Job) => void jobs.set(job.jobId, job),

  getCached: (key: string) => resultsByHash.get(key),
  putCached: (key: string, r: CheckResult) => void resultsByHash.set(key, r),

  /** Record that a listing used this file; return the other listings that did. */
  noteListing(hash: string, listingId: string): string[] {
    const set = listingsByHash.get(hash) ?? new Set<string>();
    set.add(listingId);
    listingsByHash.set(hash, set);
    return [...set].filter((l) => l !== listingId);
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
    jobs.clear(); resultsByHash.clear(); listingsByHash.clear(); hits.clear();
  },
};
