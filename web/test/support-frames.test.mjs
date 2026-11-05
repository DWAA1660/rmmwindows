import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSupportFrame } from "../src/supportFrames.ts";

const jpeg = [0xff, 0xd8, 1, 2, 0xff, 0xd9];
function frame(seq, { keyframe = false, width = 1920, height = 1080, rects = [[0, 0, width, height]] } = {}) {
  const header = new Uint8Array(14 + rects.length * 12);
  const view = new DataView(header.buffer);
  header.set([0x52, 0x4d, 0x46, 0x31]);
  view.setUint32(4, seq, true); view.setUint16(8, width, true); view.setUint16(10, height, true);
  header[12] = keyframe ? 1 : 0; header[13] = rects.length;
  rects.forEach(([x, y, w, h], index) => {
    const at = 14 + index * 12;
    view.setUint16(at, x, true); view.setUint16(at + 2, y, true); view.setUint16(at + 4, w, true); view.setUint16(at + 6, h, true);
    view.setUint32(at + 8, jpeg.length, true);
  });
  const out = new Uint8Array(header.length + rects.length * jpeg.length);
  out.set(header); rects.forEach((_, index) => out.set(jpeg, header.length + index * jpeg.length));
  return out.buffer;
}

test("parses keyframes, patches with JPEG offsets, heartbeats and legacy JPEGs", () => {
  const key = parseSupportFrame(frame(5, { keyframe: true }));
  assert.equal(key.kind, "delta"); assert.equal(key.seq, 5); assert.equal(key.keyframe, true);
  assert.deepEqual(key.rects[0], { x: 0, y: 0, width: 1920, height: 1080, start: 26, end: 32 });
  const patch = parseSupportFrame(frame(6, { rects: [[0, 0, 64, 64], [64, 0, 64, 64]] }));
  assert.equal(patch.rects.length, 2); assert.equal(patch.rects[1].start, 14 + 24 + 6);
  assert.equal(parseSupportFrame(frame(7, { rects: [] })).rects.length, 0);
  assert.deepEqual(parseSupportFrame(new Uint8Array(jpeg).buffer), { kind: "jpeg" });
});

test("rejects malformed frames", () => {
  assert.equal(parseSupportFrame(frame(1, { rects: [[1900, 0, 64, 64]] })), null);
  assert.equal(parseSupportFrame(frame(1, { keyframe: true, rects: [] })), null);
  assert.equal(parseSupportFrame(frame(1).slice(0, 20)), null);
  const extra = new Uint8Array(new Uint8Array(frame(1)).length + 1); extra.set(new Uint8Array(frame(1)));
  assert.equal(parseSupportFrame(extra.buffer), null);
  assert.equal(parseSupportFrame(new Uint8Array([1, 2, 3]).buffer), null);
});
