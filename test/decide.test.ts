import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { decide, type DecideInput } from "../src/stages/decide.ts";
import type { LocalSignals, MediaInfo, ModelAnalysis, Segment } from "../src/types.ts";

const media: MediaInfo = {
  orientation: "portrait", aspectRatio: "9:16", width: 1080, height: 1920, rotation: 0,
  fps: 30, codec: "h264", container: "mov,mp4", durationSec: 48, fileSizeMb: 42.5,
};
const signals: LocalSignals = {
  quality: { blur: 0.08, brightness: 0.62, shake: 0.15, blackFrameRatio: 0 },
  staticRatio: 0.05,
  audioActiveRatio: 0.9,
};
const seg = (startSec: number, endSec: number, scene: string, confidence = 0.9): Segment => ({ startSec, endSec, scene, confidence });
const model = (segments: Segment[], over: Partial<ModelAnalysis> = {}): ModelAnalysis => ({
  segments,
  slideshow: { isSlideshow: false, confidence: 0.97 },
  flags: { textOverlay: false, contactInfo: false, watermark: false, otherPeople: false, unsafe: false },
  suggestedCoverSec: 5, hasSpeech: null, hasMusic: null,
  framesSent: 48, inputTokens: 4300, outputTokens: 350, costUsd: 0.0016, model: "test",
  ...over,
});
const tour = [
  seg(0, 3, "talking_head"), seg(3, 17, "living_room", 0.94), seg(17, 19, "hallway"),
  seg(19, 30, "bedroom", 0.91), seg(30, 31, "hallway"), seg(31, 37, "bathroom", 0.88),
  seg(37, 44, "kitchen", 0.83), seg(44, 48, "balcony"),
];
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  media, streams: { hasVideo: true, hasAudio: true, hasSpeech: null, hasMusic: null },
  reasons: [], signals, model: model(tour), duplicateOfListings: [], ...over,
});

test("a good walkthrough with a short intro is approved", () => {
  const r = decide(input(), config);
  assert.equal(r.decision, "approve");
  assert.deepEqual(r.reasons, []);
  assert.ok(r.score >= 80, `score ${r.score}`);
  assert.equal(r.coverage?.distinctRooms, 5); // living, bedroom, bathroom, kitchen, balcony; not hallway
  assert.deepEqual(r.rooms.find((x) => x.type === "living_room"), { type: "living_room", confidence: 0.94, firstSeenSec: 3, onScreenSec: 14 });
  assert.equal(r.talkingHead?.ratio, 0.06);
});

test("mostly talking head is rejected", () => {
  const r = decide(input({ model: model([seg(0, 30, "talking_head"), seg(30, 39, "living_room"), seg(39, 48, "bedroom")]) }), config);
  assert.equal(r.decision, "reject");
  assert.deepEqual(r.reasons.map((x) => x.code), ["TALKING_HEAD"]);
});

test("exterior-only video is rejected for too few rooms", () => {
  const r = decide(input({ model: model([seg(0, 30, "building_exterior"), seg(30, 48, "facilities")]) }), config);
  assert.equal(r.decision, "reject");
  assert.deepEqual(r.reasons.map((x) => x.code), ["TOO_FEW_ROOMS"]);
  assert.equal(r.coverage?.exteriorRatio, 1);
});

test("a room glimpsed for one second does not count", () => {
  const r = decide(input({ model: model([seg(0, 47, "living_room"), seg(47, 48, "bedroom")]) }), config);
  assert.equal(r.coverage?.distinctRooms, 1);
  assert.equal(r.decision, "reject");
});

test("slideshow: model judgement or frozen frames", () => {
  const byModel = decide(input({ model: model(tour, { slideshow: { isSlideshow: true, confidence: 0.9 } }) }), config);
  assert.equal(byModel.decision, "reject");
  assert.equal(byModel.slideshow?.isSlideshow, true);

  const byFrames = decide(input({ model: null, signals: { ...signals, staticRatio: 0.9 } }), config);
  assert.equal(byFrames.decision, "reject");
  assert.equal(byFrames.reasons[0].code, "SLIDESHOW");

  const unsure = decide(input({ signals: { ...signals, staticRatio: 0.6 } }), config);
  assert.equal(unsure.decision, "review");
});

test("content flags are reported; only unsafe sends to review by default", () => {
  const flagged = (f: Partial<ModelAnalysis["flags"]>) =>
    decide(input({ model: model(tour, { flags: { ...model(tour).flags, ...f } }) }), config);
  const contact = flagged({ contactInfo: true, textOverlay: true });
  assert.equal(contact.decision, "approve");
  assert.equal(contact.contentFlags?.contactInfo, true);
  const unsafe = flagged({ unsafe: true });
  assert.equal(unsafe.decision, "review");
  assert.equal(unsafe.reasons[0].code, "UNSAFE_CONTENT");
});

test("earlier-stage reasons carry through; reject wins over review", () => {
  const r = decide(input({ reasons: [{ code: "TOO_LONG", message: "x", severity: "review" }] }), config);
  assert.equal(r.decision, "review");
  const both = decide(input({
    reasons: [{ code: "TOO_LONG", message: "x", severity: "review" }],
    model: model([seg(0, 48, "talking_head")]),
  }), config);
  assert.equal(both.decision, "reject");
});

test("dark and mostly-black videos", () => {
  const dark = decide(input({ signals: { ...signals, quality: { ...signals.quality, brightness: 0.05 } } }), config);
  assert.equal(dark.decision, "review");
  const black = decide(input({ signals: { ...signals, quality: { ...signals.quality, blackFrameRatio: 0.7 } } }), config);
  assert.equal(black.decision, "reject");
});
