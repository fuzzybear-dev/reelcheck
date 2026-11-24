import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { callGemini } from "../src/stages/model.ts";

const cfg = { ...config, geminiApiKey: "test", geminiAttempts: 3, geminiAttemptTimeoutMs: 50, geminiRetryBaseMs: 1, geminiFallbackModel: "" };
const ok = () => new Response(JSON.stringify({ candidates: [] }), { status: 200 });
const status = (s: number) => new Response("{}", { status: s });

/** Fake fetch that plays a script of responses; "hang" never answers until aborted. */
function scripted(steps: Array<Response | "hang">) {
  const urls: string[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    const step = steps.shift()!;
    if (step !== "hang") return step;
    return new Promise((_, reject) =>
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  }) as unknown as typeof fetch;
  return { impl, urls };
}

test("retries 503 overload and succeeds", async () => {
  const f = scripted([status(503), status(429), ok()]);
  const r = await callGemini({}, cfg, undefined, f.impl);
  assert.equal(f.urls.length, 3);
  assert.equal(r.model, cfg.geminiModel);
});

test("a stalled request times out and is retried", async () => {
  const f = scripted(["hang", ok()]);
  await callGemini({}, cfg, undefined, f.impl);
  assert.equal(f.urls.length, 2);
});

test("400/403 fail immediately without retrying", async () => {
  const f = scripted([status(403), ok()]);
  await assert.rejects(callGemini({}, cfg, undefined, f.impl), /403/);
  assert.equal(f.urls.length, 1);
});

test("gives up after the configured attempts with the last error", async () => {
  const f = scripted(["hang", status(503), "hang"]);
  await assert.rejects(callGemini({}, cfg, undefined, f.impl), /timed out after 50 ms \(after 3 attempts\)/);
});

test("last attempt uses the fallback model", async () => {
  const f = scripted([status(503), status(503), ok()]);
  const r = await callGemini({}, { ...cfg, geminiFallbackModel: "gemini-2.5-flash-lite" }, undefined, f.impl);
  assert.equal(r.model, "gemini-2.5-flash-lite");
  assert.match(f.urls[2], /gemini-2\.5-flash-lite:generateContent/);
  assert.match(f.urls[0], /gemini-3\.1-flash-lite:generateContent/);
});

test("cancelling the job stops retries", async () => {
  const ac = new AbortController();
  const f = scripted(["hang", ok()]);
  const p = callGemini({}, { ...cfg, geminiAttemptTimeoutMs: 10_000 }, ac.signal, f.impl);
  ac.abort(new Error("job timeout"));
  await assert.rejects(p, /job timeout/);
  assert.equal(f.urls.length, 1);
});
