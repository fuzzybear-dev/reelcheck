import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAX_LINES_PER_JOB = 300;
let fileReady = "";

/**
 * Logger for one job. Each line goes to stdout, to the log file (if set) and
 * into `lines`, which the API returns at GET /v1/video-checks/:id/logs.
 * Lines look like: 2026-11-24T09:12:03.120Z [jobId] +842ms stage 2: …
 */
export function createJobLogger(jobId: string, logFile: string, lines: string[] = []) {
  const started = Date.now();
  const log = (msg: string) => {
    const line = `${new Date().toISOString()} [${jobId}] +${Date.now() - started}ms ${msg}`;
    console.log(line);
    if (lines.length < MAX_LINES_PER_JOB) lines.push(line);
    if (logFile) {
      try {
        if (fileReady !== logFile) {
          mkdirSync(dirname(logFile), { recursive: true });
          fileReady = logFile;
        }
        appendFileSync(logFile, line + "\n");
      } catch {
        // A full disk or bad path must not fail the check itself.
      }
    }
  };
  return { log, lines };
}
