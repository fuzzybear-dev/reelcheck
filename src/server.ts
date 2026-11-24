import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config, type Config } from "./config.ts";
import { isAllowedUrl } from "./fetch.ts";
import { createQueue, jobView } from "./jobs.ts";
import { store } from "./store.ts";
import type { CheckRequest } from "./types.ts";

const HOUR = 3_600_000;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Validate a POST body. Returns the request or a list of problems. */
export function parseRequest(body: unknown, cfg: Config): CheckRequest | string[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const str = (k: string, max = 200) => {
    const v = b[k];
    if (typeof v !== "string" || !v.trim() || v.length > max) errors.push(`${k} is required (string, max ${max} chars)`);
    return typeof v === "string" ? v.trim() : "";
  };
  const videoUrl = str("videoUrl", 2048);
  const callbackUrl = typeof b.callbackUrl === "string" && b.callbackUrl ? b.callbackUrl : undefined;
  if (callbackUrl && !isAllowedUrl(callbackUrl, cfg.allowedCallbackHosts))
    errors.push("callbackUrl must be HTTPS on an approved callback host");
  return errors.length ? errors : { videoUrl, callbackUrl };
}

/** Client address for rate limiting. X-Forwarded-For is only trusted behind a known proxy. */
function clientIp(req: IncomingMessage, cfg: Config): string {
  const fwd = req.headers["x-forwarded-for"];
  if (cfg.trustProxy && typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

export function createApp(cfg: Config = config, queue = createQueue(cfg)) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, queued: queue.size });

      if (req.method === "POST" && url.pathname === "/v1/video-checks") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          return send(res, 400, { error: "Body must be JSON" });
        }
        const parsed = parseRequest(body, cfg);
        if (Array.isArray(parsed)) return send(res, 400, { error: "Invalid request", details: parsed });
        if (!store.allow(`ip:${clientIp(req, cfg)}`, cfg.rateLimitPerClientPerHour, HOUR)) {
          res.setHeader("retry-after", "3600");
          return send(res, 429, { error: "Too many checks from this client; try again later" });
        }
        const job = queue.enqueue(parsed);
        res.setHeader("location", `/v1/video-checks/${job.jobId}`);
        return send(res, 202, { jobId: job.jobId, status: job.status });
      }

      const m = url.pathname.match(/^\/v1\/video-checks\/([\w-]+)(\/logs)?$/);
      if (req.method === "GET" && m) {
        const job = store.getJob(m[1]);
        if (!job) return send(res, 404, { error: "Job not found" });
        if (m[2]) return send(res, 200, { jobId: job.jobId, status: job.status, attempts: job.attempts, logs: job.logs });
        return send(res, 200, jobView(job));
      }

      send(res, 404, { error: "Not found" });
    } catch (err) {
      console.error(err);
      send(res, 500, { error: "Internal error" });
    }
  });
}

if (import.meta.main) {
  if (!config.allowedVideoHosts.length) console.warn("ALLOWED_VIDEO_HOSTS is empty: every video URL will be rejected");
  if (!config.geminiApiKey) console.warn("GEMINI_API_KEY is not set: videos that pass stage 2 will go to review");
  createApp().listen(config.port, () => console.log(`ReelCheck listening on :${config.port}`));
}
