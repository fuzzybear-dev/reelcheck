import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { clientIp, parseRequest } from "../src/server.ts";
import { store } from "../src/store.ts";

const cfg = { ...config, allowedCallbackHosts: ["hooks.example.com"] };

test("only videoUrl is required; unknown fields are ignored", () => {
  assert.deepEqual(parseRequest({ videoUrl: " https://x/v.mp4 " }, cfg), { videoUrl: "https://x/v.mp4", callbackUrl: undefined });
  assert.deepEqual(parseRequest({ videoUrl: "https://x/v.mp4", listingId: "L1", callbackUrl: "" }, cfg), { videoUrl: "https://x/v.mp4", callbackUrl: undefined });
});

test("rejects missing videoUrl and callbacks to unapproved hosts", () => {
  assert.ok(Array.isArray(parseRequest({}, cfg)));
  const r = parseRequest({ videoUrl: "https://x/v.mp4", callbackUrl: "https://evil.io/hook" }, cfg);
  assert.deepEqual(r, ["callbackUrl must be HTTPS on an approved callback host"]);
});

test("duplicate tracking returns a count, never other callers' job IDs", () => {
  store._reset();
  assert.equal(store.noteFile("h1"), 0);
  assert.equal(store.noteFile("h1"), 1);
  assert.equal(store.noteFile("h1"), 2);
  assert.equal(store.noteFile("h2"), 0);
});

test("client IP ignores X-Forwarded-For unless trusted, then uses the right-most entry", () => {
  const req = (xff?: string) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "10.0.0.5" } }) as never;
  assert.equal(clientIp(req("1.1.1.1"), { trustProxy: false }), "10.0.0.5");
  // Client forges "6.6.6.6"; the proxy appends the real address last.
  assert.equal(clientIp(req("6.6.6.6, 203.0.113.9"), { trustProxy: true }), "203.0.113.9");
  assert.equal(clientIp(req(" , "), { trustProxy: true }), "10.0.0.5");
  assert.equal(clientIp(req(), { trustProxy: true }), "10.0.0.5");
});

test("rate limiter prunes expired clients so memory stays bounded", () => {
  store._reset();
  const t0 = 1_000_000;
  for (let i = 0; i <= 10_001; i++) store.allow(`ip:${i}`, 5, 1000, t0);
  assert.ok(store._rateKeys() > 10_000);
  store.allow("ip:new", 5, 1000, t0 + 5000); // window has passed for all old keys
  assert.equal(store._rateKeys(), 1);
  assert.equal(store.allow("ip:new", 1, 1000, t0 + 5000), false); // limit still enforced
});
