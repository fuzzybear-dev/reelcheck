import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { aspectRatio, evaluateProbe, rotationOf, type FfprobeOutput } from "../src/stages/probe.ts";

const probe = (over: { w?: number; h?: number; rot?: number; dur?: number; codec?: string; fmt?: string; audio?: boolean } = {}): FfprobeOutput => ({
  streams: [
    {
      codec_type: "video", codec_name: over.codec ?? "h264", width: over.w ?? 1080, height: over.h ?? 1920,
      avg_frame_rate: "30000/1001",
      side_data_list: over.rot !== undefined ? [{ side_data_type: "Display Matrix", rotation: over.rot }] : undefined,
    },
    ...(over.audio === false ? [] : [{ codec_type: "audio", codec_name: "aac" }]),
  ],
  format: { format_name: over.fmt ?? "mov,mp4,m4a,3gp,3g2,mj2", duration: String(over.dur ?? 48), size: "44564480" },
});
const codes = (p: FfprobeOutput) => evaluateProbe(p, config, null).reasons.map((r) => r.code);

test("portrait h264 mp4 passes stage 1", () => {
  const out = evaluateProbe(probe(), config, null);
  assert.deepEqual(out.reasons, []);
  assert.equal(out.media?.orientation, "portrait");
  assert.equal(out.media?.aspectRatio, "9:16");
  assert.equal(out.media?.fps, 29.97);
  assert.equal(out.media?.fileSizeMb, 42.5);
  assert.equal(out.streams.hasAudio, true);
});

test("rotation tag turns a landscape-coded phone video into portrait", () => {
  const out = evaluateProbe(probe({ w: 1920, h: 1080, rot: -90 }), config, null);
  assert.equal(out.media?.rotation, 90);
  assert.equal(out.media?.width, 1080);
  assert.equal(out.media?.height, 1920);
  assert.equal(out.media?.orientation, "portrait");
});

test("rotationOf normalises display-matrix and tag forms", () => {
  assert.equal(rotationOf({ side_data_list: [{ rotation: 90 }] }), 270);
  assert.equal(rotationOf({ tags: { rotate: "180" } }), 180);
  assert.equal(rotationOf({}), 0);
});

test("landscape, too short, low-res and unsupported codec are rejected", () => {
  assert.deepEqual(codes(probe({ w: 1920, h: 1080 })), ["LANDSCAPE"]);
  assert.deepEqual(codes(probe({ dur: 6 })), ["TOO_SHORT"]);
  assert.deepEqual(codes(probe({ w: 480, h: 854 })), ["LOW_RESOLUTION"]);
  assert.deepEqual(codes(probe({ codec: "mpeg4" })), ["UNSUPPORTED_FORMAT"]);
  assert.deepEqual(codes(probe({ fmt: "avi" })), ["UNSUPPORTED_FORMAT"]);
});

test("too long goes to review, not reject", () => {
  const r = evaluateProbe(probe({ dur: 360 }), config, null).reasons;
  assert.equal(r[0].code, "TOO_LONG");
  assert.equal(r[0].severity, "review");
  assert.equal(r[0].message, "Video is 6 min; the limit is 3 min");
});

test("no video stream", () => {
  assert.deepEqual(codes({ streams: [{ codec_type: "audio" }], format: {} }), ["NO_VIDEO_STREAM"]);
});

test("aspect ratio snaps to common ratios", () => {
  assert.equal(aspectRatio(1080, 1920), "9:16");
  assert.equal(aspectRatio(1080, 1350), "4:5");
  assert.equal(aspectRatio(1000, 1000), "1:1");
  assert.equal(aspectRatio(700, 2000), "0.35:1");
});
