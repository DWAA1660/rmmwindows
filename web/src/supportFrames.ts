/**
 * Screen frames from the support relay. Agents 0.1.11+ send "RMF1" frames: a keyframe repaints the whole surface,
 * other frames patch only changed rectangles, and a frame without rectangles is a heartbeat for a still screen.
 * Layout (little-endian): "RMF1", seq u32, width u16, height u16, flags u8 (bit0 keyframe), count u8,
 * count x (x,y,w,h u16, jpegLength u32), then the JPEGs. Older agents send one whole JPEG per frame.
 */
export type FrameRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
};
export type SupportFrame =
  | { kind: "jpeg" }
  | {
      kind: "delta";
      seq: number;
      width: number;
      height: number;
      keyframe: boolean;
      rects: FrameRect[];
    };

const isJpeg = (bytes: Uint8Array, start: number, length: number) =>
  length >= 4 &&
  bytes[start] === 0xff &&
  bytes[start + 1] === 0xd8 &&
  bytes[start + length - 2] === 0xff &&
  bytes[start + length - 1] === 0xd9;

/** Returns null for anything malformed, so a bad frame is never drawn. */
export function parseSupportFrame(buffer: ArrayBuffer): SupportFrame | null {
  const bytes = new Uint8Array(buffer);
  if (isJpeg(bytes, 0, bytes.length)) return { kind: "jpeg" };
  if (
    bytes.length < 14 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x4d ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x31
  )
    return null;
  const view = new DataView(buffer);
  const seq = view.getUint32(4, true),
    width = view.getUint16(8, true),
    height = view.getUint16(10, true),
    flags = bytes[12],
    count = bytes[13];
  if (!width || !height || flags & ~1 || count > 64 || (flags & 1 && !count))
    return null;
  let offset = 14 + count * 12;
  if (bytes.length < offset) return null;
  const rects: FrameRect[] = [];
  for (let index = 0; index < count; index++) {
    const at = 14 + index * 12;
    const x = view.getUint16(at, true),
      y = view.getUint16(at + 2, true),
      w = view.getUint16(at + 4, true),
      h = view.getUint16(at + 6, true),
      length = view.getUint32(at + 8, true);
    if (
      !w ||
      !h ||
      x + w > width ||
      y + h > height ||
      offset + length > bytes.length ||
      !isJpeg(bytes, offset, length)
    )
      return null;
    rects.push({ x, y, width: w, height: h, start: offset, end: offset + length });
    offset += length;
  }
  if (offset !== bytes.length) return null;
  return { kind: "delta", seq, width, height, keyframe: (flags & 1) === 1, rects };
}
