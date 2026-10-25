// Bounded ISO-BMFF audio sampling. Sample tables are read lazily; video is not decoded.
const { requestRange } = require("./range.cjs");
const fail = () => {
  throw Error("AUDIO_SAMPLE_MP4");
};
function u64(b, p) {
  const value = b.readUInt32BE(p) * 4294967296 + b.readUInt32BE(p + 4);
  if (!Number.isSafeInteger(value)) fail();
  return value;
}
function boxes(b, start, end) {
  const result = [];
  for (let p = start; p < end;) {
    if (p + 8 > end || result.length >= 30000) fail();
    const n = b.readUInt32BE(p),
      wide = n === 1;
    if (wide && p + 16 > end) fail();
    const size = wide ? u64(b, p + 8) : n || end - p;
    if (size < (wide ? 16 : 8) || p + size > end) fail();
    result.push({
      type: b.toString("ascii", p + 4, p + 8),
      data: p + (wide ? 16 : 8),
      end: p + size
    });
    p += size;
  }
  return result;
}
const child = (b, parent, type) => boxes(b, parent.data, parent.end).find((x) => x.type === type);
function count(b, box, width, offset = 8) {
  if (!box || box.data + offset > box.end) fail();
  const n = b.readUInt32BE(box.data + 4);
  if (n > 2000000 || box.data + offset + n * width > box.end) fail();
  return n;
}
function aacConfig(b, esds) {
  function descriptor(start, end, wanted) {
    for (let p = start; p < end;) {
      const tag = b[p++];
      let size = 0,
        last = false;
      for (let i = 0; i < 4 && p < end; i++) {
        const x = b[p++];
        size = size * 128 + (x & 127);
        if (!(x & 128)) {
          last = true;
          break;
        }
      }
      const limit = p + size;
      if (!last || limit > end) fail();
      if (tag === wanted) return b.subarray(p, limit);
      if (tag === 3) {
        if (p + 3 > limit) fail();
        const flags = b[p + 2];
        let sub = p + 3;
        if (flags & 128) sub += 2;
        if (flags & 64) {
          if (sub >= limit) fail();
          sub += 1 + b[sub];
        }
        if (flags & 32) sub += 2;
        const found = descriptor(sub, limit, wanted);
        if (found) return found;
      } else if (tag === 4) {
        if (p + 13 > limit || b[p] !== 0x40) fail();
        const found = descriptor(p + 13, limit, wanted);
        if (found) return found;
      }
      p = limit;
    }
    return null;
  }
  if (!esds) fail();
  const data = descriptor(esds.data + 4, esds.end, 5);
  if (!data || data.length < 2) fail();
  const object = data[0] >> 3,
    frequency = ((data[0] & 7) << 1) | (data[1] >> 7),
    channels = (data[1] >> 3) & 15;
  if (object !== 2 || frequency > 12 || channels < 1 || channels > 7 || data[1] & 7) fail();
  return { object, frequency, channels };
}
function adts(packet, config) {
  const n = packet.length + 7;
  if (n > 8191) fail();
  return Buffer.concat([
    Buffer.from([
      255,
      241,
      ((config.object - 1) << 6) | (config.frequency << 2) | (config.channels >> 2),
      ((config.channels & 3) << 6) | (n >> 11),
      (n >> 3) & 255,
      ((n & 7) << 5) | 31,
      252
    ]),
    packet
  ]);
}
function editShift(b, trak, movieScale, trackScale) {
  const edts = child(b, trak, "edts");
  if (!edts) return 0;
  const elst = child(b, edts, "elst");
  if (!elst) return 0;
  const wide = b[elst.data] === 1,
    width = wide ? 20 : 12,
    n = count(b, elst, width);
  if (!n || n > 2) fail();
  let empty = 0;
  for (let i = 0; i < n; i++) {
    const p = elst.data + 8 + i * width,
      duration = wide ? u64(b, p) : b.readUInt32BE(p);
    const timeOffset = p + (wide ? 8 : 4);
    const negative = b.readInt32BE(timeOffset) < 0;
    if (
      wide &&
      negative &&
      (b.readUInt32BE(timeOffset) !== 0xffffffff || b.readUInt32BE(timeOffset + 4) !== 0xffffffff)
    )
      fail();
    const media = wide ? (negative ? -1 : u64(b, timeOffset)) : b.readInt32BE(timeOffset);
    if (b.readUInt32BE(p + width - 4) !== 65536) fail();
    if (media === -1 && i === 0 && n === 2) empty = duration / movieScale;
    else {
      if (media < 0 || i !== n - 1) fail();
      return (empty - media / trackScale) * 1000;
    }
  }
  fail();
}
async function extractMp4AudioSample(options, context, header) {
  const read = async (start, end, max) => requestRange(options.url, start, end, max, 0, context);
  const total = header.totalSize;
  let offset = 0,
    moov = null;
  for (let i = 0; i < 512 && offset < total; i++) {
    let data;
    if (offset + 16 <= header.buffer.length) data = header.buffer.subarray(offset, offset + 16);
    else data = (await read(offset, Math.min(total - 1, offset + 15), 16)).buffer;
    if (data.length < 8) fail();
    const n = data.readUInt32BE(0),
      size = n === 1 ? u64(data, 8) : n || total - offset;
    if (size < 8 || offset + size > total) fail();
    const type = data.toString("ascii", 4, 8);
    if (type === "moov") {
      if (size > 8 * 1024 * 1024) fail();
      moov =
        offset + size <= header.buffer.length
          ? header.buffer.subarray(offset, offset + size)
          : (await read(offset, offset + size - 1, size)).buffer;
      break;
    }
    offset += size;
  }
  if (!moov) fail();
  const root = boxes(moov, 0, moov.length)[0],
    mvhd = child(moov, root, "mvhd");
  const movieScale = moov.readUInt32BE(mvhd.data + (moov[mvhd.data] === 1 ? 20 : 12));
  const tracks = boxes(moov, root.data, root.end)
    .filter((x) => x.type === "trak")
    .filter((trak) => {
      const mdia = child(moov, trak, "mdia"),
        hdlr = mdia && child(moov, mdia, "hdlr");
      return hdlr && moov.toString("ascii", hdlr.data + 8, hdlr.data + 12) === "soun";
    });
  if (options.selection.singleTrack && tracks.length !== 1) fail();
  const trak = tracks[options.selection.audioIndex];
  if (!trak) fail();
  const mdia = child(moov, trak, "mdia"),
    mdhd = child(moov, mdia, "mdhd"),
    minf = child(moov, mdia, "minf"),
    stbl = child(moov, minf, "stbl");
  if (!mdhd || !stbl || !movieScale) fail();
  const scale = moov.readUInt32BE(mdhd.data + (moov[mdhd.data] === 1 ? 20 : 12));
  if (!scale) fail();
  const shift = editShift(moov, trak, movieScale, scale);
  const stsd = child(moov, stbl, "stsd");
  if (!stsd || moov.readUInt32BE(stsd.data + 4) !== 1) fail();
  const entry = boxes(moov, stsd.data + 8, stsd.end)[0];
  const format = { mp4a: "aac", "ac-3": "ac3", "ec-3": "eac3" }[entry.type];
  if (!format) fail();
  if (entry.data + 28 > entry.end || moov.readUInt16BE(entry.data + 8) !== 0) fail();
  const config =
    format === "aac"
      ? aacConfig(
          moov,
          boxes(moov, entry.data + 28, entry.end).find((x) => x.type === "esds")
        )
      : null;
  const stts = child(moov, stbl, "stts"),
    stsz = child(moov, stbl, "stsz"),
    stsc = child(moov, stbl, "stsc"),
    chunks = child(moov, stbl, "stco") || child(moov, stbl, "co64");
  if (!stsz || stsz.data + 12 > stsz.end || child(moov, stbl, "ctts")) fail();
  const sampleCount = moov.readUInt32BE(stsz.data + 8),
    fixed = moov.readUInt32BE(stsz.data + 4);
  if (sampleCount > 2000000 || (!fixed && stsz.data + 12 + sampleCount * 4 > stsz.end)) fail();
  const sampleSize = (i) => fixed || moov.readUInt32BE(stsz.data + 12 + i * 4);
  const nTimes = count(moov, stts, 8),
    nChunks = count(moov, chunks, chunks.type === "co64" ? 8 : 4),
    nMaps = count(moov, stsc, 12);
  const wanted = [],
    wantedEnd = options.positionMs + options.durationMs;
  let tick = 0,
    index = 0;
  for (let i = 0; i < nTimes; i++) {
    const p = stts.data + 8 + i * 8,
      n = moov.readUInt32BE(p),
      delta = moov.readUInt32BE(p + 4);
    if (!delta || index + n > sampleCount) fail();
    for (let j = 0; j < n; j++, index++, tick += delta) {
      const startMs = (tick / scale) * 1000 + shift,
        endMs = ((tick + delta) / scale) * 1000 + shift;
      if (endMs > options.positionMs - 150 && startMs < wantedEnd)
        wanted.push({ index, startMs, endMs });
      if (wanted.length > 40000) fail();
    }
  }
  if (
    index !== sampleCount ||
    !wanted.length ||
    wanted[0].startMs > options.positionMs ||
    wanted[wanted.length - 1].endMs < wantedEnd
  )
    fail();
  let sampleIndex = 0,
    mapIndex = 0,
    found = 0;
  const packets = [];
  let size = 0,
    cacheStart = -1,
    cache = Buffer.alloc(0);
  for (let chunk = 1; chunk <= nChunks && found < wanted.length; chunk++) {
    while (mapIndex + 1 < nMaps && moov.readUInt32BE(stsc.data + 8 + (mapIndex + 1) * 12) <= chunk)
      mapIndex++;
    const p = stsc.data + 8 + mapIndex * 12;
    if (!nMaps || moov.readUInt32BE(stsc.data + 8) !== 1 || moov.readUInt32BE(p + 8) !== 1) fail();
    const n = moov.readUInt32BE(p + 4);
    if (!n || sampleIndex + n > sampleCount) fail();
    if (sampleIndex + n <= wanted[0].index) {
      sampleIndex += n;
      continue;
    }
    const cp = chunks.data + 8 + (chunk - 1) * (chunks.type === "co64" ? 8 : 4);
    let cursor = chunks.type === "co64" ? u64(moov, cp) : moov.readUInt32BE(cp);
    for (let j = 0; j < n && found < wanted.length; j++, sampleIndex++) {
      const length = sampleSize(sampleIndex);
      if (length < 1 || length > 512 * 1024 || cursor + length > total) fail();
      if (sampleIndex === wanted[found].index) {
        if (cursor < cacheStart || cursor + length > cacheStart + cache.length) {
          cacheStart = cursor;
          cache = (
            await read(
              cursor,
              Math.min(total - 1, cursor + Math.max(length, 65536) - 1),
              Math.max(length, 65536)
            )
          ).buffer;
        }
        let packet = cache.subarray(cursor - cacheStart, cursor - cacheStart + length);
        if (config) packet = adts(packet, config);
        size += packet.length;
        if (size > 4 * 1024 * 1024) fail();
        packets.push(Buffer.from(packet));
        found++;
      }
      cursor += length;
    }
  }
  if (found !== wanted.length) fail();
  return {
    input: Buffer.concat(packets, size),
    format,
    audioIndex: options.selection.audioIndex,
    startMs: wanted[0].startMs,
    endMs: wanted[wanted.length - 1].endMs,
    networkBytes: context.bytes
  };
}
module.exports = { extractMp4AudioSample, boxes, aacConfig };
