// Kept separate from playback remuxing: malformed lacing must not escape its block.
function vint(b, p, signed) {
  let width = 1;
  while (width <= 8 && !(b[p] & (1 << (8 - width)))) width++;
  if (width > 8 || p + width > b.length) throw Error("AUDIO_SAMPLE_LACING");
  let value = b[p] & ((1 << (8 - width)) - 1);
  for (let i = 1; i < width; i++) value = value * 256 + b[p + i];
  if (signed) value -= 2 ** (7 * width - 1) - 1;
  if (!Number.isSafeInteger(value)) throw Error("AUDIO_SAMPLE_LACING");
  return { value, width };
}
function packets(b, element) {
  b = b.subarray(element.dataStart, element.dataEnd);
  const track = vint(b, 0);
  let p = track.width;
  if (p + 3 > b.length) throw Error("AUDIO_SAMPLE_BLOCK");
  const relative = b.readInt16BE(p),
    lace = b[p + 2] & 6;
  p += 3;
  const sizes = [];
  if (!lace) sizes.push(b.length - p);
  else {
    if (p >= b.length) throw Error("AUDIO_SAMPLE_LACING");
    const count = b[p++] + 1;
    let total = 0;
    if (lace === 4) {
      if ((b.length - p) % count) throw Error("AUDIO_SAMPLE_LACING");
      for (let i = 0; i < count; i++) sizes.push((b.length - p) / count);
    } else {
      for (let i = 0; i < count - 1; i++) {
        let size;
        if (lace === 2) {
          size = 0;
          let byte;
          do {
            if (p >= b.length) throw Error("AUDIO_SAMPLE_LACING");
            byte = b[p++];
            size += byte;
          } while (byte === 255);
        } else {
          const v = vint(b, p, i !== 0);
          p += v.width;
          size = i ? sizes[i - 1] + v.value : v.value;
        }
        if (size < 1 || size > b.length) throw Error("AUDIO_SAMPLE_LACING");
        sizes.push(size);
        total += size;
      }
      sizes.push(b.length - p - total);
    }
  }
  const frames = sizes.map((size) => {
    if (size < 1 || p + size > b.length) throw Error("AUDIO_SAMPLE_LACING");
    const frame = b.subarray(p, p + size);
    p += size;
    return frame;
  });
  if (p !== b.length) throw Error("AUDIO_SAMPLE_LACING");
  return { track: track.value, relative, frames };
}
function children(b, start, end) {
  const media = require("./media.cjs");
  const out = [];
  while (start < end) {
    const e = media.readElement(b, start, end, false);
    if (!e || e.truncated || e.declaredDataEnd <= start) throw Error("AUDIO_SAMPLE_ELEMENT");
    out.push(e);
    start = e.declaredDataEnd;
    if (out.length > 30000) throw Error("AUDIO_SAMPLE_ELEMENT_LIMIT");
  }
  return out;
}
module.exports = {
  packets,
  children,
  blockTrack(b) {
    return vint(b, 0).value;
  }
};
