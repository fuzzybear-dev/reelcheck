import { test } from "node:test";
import assert from "node:assert/strict";
import { brightnessScore, parseFrameMetadata, shakeScore, sumIntervals } from "../src/stages/signals.ts";
import { normaliseSegments, sampleFps, costOf } from "../src/stages/model.ts";
import { isAllowedUrl } from "../src/fetch.ts";
import { config } from "../src/config.ts";

test("parses metadata=print output", () => {
  const text = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.signalstats.YAVG=120.5",
    "lavfi.signalstats.YDIF=0",
    "lavfi.blur=2.9",
    "frame:1    pts:512     pts_time:0.5",
    "lavfi.signalstats.YAVG=118",
    "lavfi.signalstats.YDIF=3.2",
    "lavfi.blur=3.1",
  ].join("\n");
  const f = parseFrameMetadata(text);
  assert.equal(f.length, 2);
  assert.deepEqual(f[1], { t: 0.5, yavg: 118, ydif: 3.2, blur: 3.1 });
});

test("sums ffmpeg detector intervals, including one open at EOF", () => {
  const log = `[blackdetect @ 0x1] black_start:0 black_end:2.5 black_duration:2.5
[blackdetect @ 0x1] black_start:10 black_end:11 black_duration:1
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 15`;
  assert.equal(sumIntervals(log, "black_start", "black_end", 20), 3.5);
  assert.equal(sumIntervals(log, "freeze_start", "freeze_end", 20), 5);
  const silence = "[silencedetect @ 0x3] silence_start: -0.01\n[silencedetect @ 0x3] silence_end: 4 | silence_duration: 4";
  assert.equal(sumIntervals(silence, "silence_start", "silence_end", 20), 4);
});

test("brightness and shake heuristics stay in 0-1", () => {
  assert.equal(brightnessScore([16, 16]), 0);
  assert.equal(brightnessScore([235]), 1);
  assert.equal(shakeScore([0, 5, 5, 5, 5]), 0);
  assert.ok(shakeScore([0, 1, 20, 2, 25, 1]) > 0.5);
});

test("frame sampling caps the number of frames", () => {
  assert.equal(sampleFps(48, config), 1);
  assert.equal(sampleFps(180, config), 0.333); // 60-frame cap
});

test("segments are clipped, sorted and de-overlapped", () => {
  const out = normaliseSegments([
    { startSec: 10, endSec: 60, scene: "kitchen", confidence: 2 },
    { startSec: -1, endSec: 12, scene: "sauna", confidence: 0.5 },
  ], 48);
  assert.deepEqual(out, [
    { startSec: 0, endSec: 12, scene: "other", confidence: 0.5 },
    { startSec: 12, endSec: 48, scene: "kitchen", confidence: 1 },
  ]);
});

test("cost uses token counts from usage metadata", () => {
  const c = costOf({ promptTokenCount: 4300, candidatesTokenCount: 300, thoughtsTokenCount: 50 }, config);
  assert.equal(c.input, 4300);
  assert.equal(c.output, 350);
  assert.equal(c.usd, (4300 * config.priceInputPerM + 350 * config.priceOutputPerM) / 1e6);
});

test("URL allowlist", () => {
  const hosts = ["uploads.example.com"];
  assert.equal(isAllowedUrl("https://uploads.example.com/a.mp4", hosts), true);
  assert.equal(isAllowedUrl("https://cdn.uploads.example.com/a.mp4", hosts), true);
  assert.equal(isAllowedUrl("http://uploads.example.com/a.mp4", hosts), false);
  assert.equal(isAllowedUrl("https://uploads.example.com.evil.io/a.mp4", hosts), false);
  assert.equal(isAllowedUrl("https://user:pw@uploads.example.com/a.mp4", hosts), false);
  assert.equal(isAllowedUrl("https://uploads.example.com:8443/a.mp4", hosts), false);
  assert.equal(isAllowedUrl("not a url", hosts), false);
  assert.equal(isAllowedUrl("https://uploads.example.com/a.mp4", []), false);
});
