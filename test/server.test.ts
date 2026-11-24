import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { parseRequest } from "../src/server.ts";
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

test("duplicate tracking returns earlier jobs for the same file", () => {
  store._reset();
  assert.deepEqual(store.noteFile("h1", "job-a"), []);
  assert.deepEqual(store.noteFile("h1", "job-b"), ["job-a"]);
  assert.deepEqual(store.noteFile("h1", "job-c"), ["job-a", "job-b"]);
  assert.deepEqual(store.noteFile("h2", "job-d"), []);
});
