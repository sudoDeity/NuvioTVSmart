// Bounded, read-only Matroska sampling. No playback session or remuxing state.
const media = require("./media.cjs");
const { children, packets, blockTrack } = require("./packets.cjs");
const { requestRange } = require("./range.cjs");
const LIMIT = 4 * 1024 * 1024;
const rates = [48000, 44100, 32000];
const bitrates = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640
];
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const uint = (b, e) => {
  if (!e) return 0;
  const n = b.subarray(e.dataStart, e.dataEnd).reduce((n, byte) => n * 256 + byte, 0);
  if (!Number.isSafeInteger(n)) fail("AUDIO_SAMPLE_NUMBER");
  return n;
};
function frameInfo(b, format) {
  if (format === "aac") {
    if (b.length < 7 || b[0] !== 255 || (b[1] & 246) !== 240) fail("AUDIO_SAMPLE_AAC");
    const rate = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
    ][(b[2] >> 2) & 15];
    const bytes = ((b[3] & 3) << 11) | (b[4] << 3) | (b[5] >> 5);
    if (!rate || bytes < 7 || bytes > b.length || b[6] & 3) fail("AUDIO_SAMPLE_AAC");
    return { rate, bytes, samples: 1024 };
  }
  if (format === "dts") {
    if (b.length < 10 || b.readUInt32BE(0) !== 0x7ffe8001) fail("AUDIO_SAMPLE_DTS");
    const bytes = (((b[5] & 3) << 12) | (b[6] << 4) | (b[7] >> 4)) + 1;
    const rate = [
      0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 96000, 192000
    ][(b[8] >> 2) & 15];
    if (!rate || bytes < 10 || bytes > b.length) fail("AUDIO_SAMPLE_DTS");
    return { rate, bytes, samples: ((((b[4] & 1) << 6) | (b[5] >> 2)) + 1) * 32 };
  }
  if (format === "truehd") {
    if (b.length < 4) fail("AUDIO_SAMPLE_TRUEHD");
    const bytes = (b.readUInt16BE(0) & 4095) * 2;
    if (bytes < 4 || bytes > b.length) fail("AUDIO_SAMPLE_TRUEHD");
    const major = b.length >= 9 && b.readUInt32BE(4) === 0xf8726fba;
    const code = major ? b[8] >> 4 : null;
    return {
      bytes,
      major,
      rate: major ? (code & 8 ? 44100 : 48000) * 2 ** (code & 7) : null,
      samples: null
    };
  }
  if (b.length < 7 || b.readUInt16BE(0) !== 0x0b77) fail("AUDIO_SAMPLE_FRAME");
  const bsid = b[5] >> 3;
  let bytes, rate, samples;
  if (format === "ac3") {
    const code = b[4] & 63,
      sr = b[4] >> 6,
      kbps = bitrates[code >> 1];
    if (bsid > 10 || sr === 3 || !kbps) fail("AUDIO_SAMPLE_FRAME");
    rate = rates[sr] >> Math.max(bsid - 8, 0);
    bytes =
      sr === 0 ? kbps * 4 : sr === 2 ? kbps * 6 : 2 * (Math.floor((kbps * 320) / 147) + (code & 1));
    samples = 1536;
  } else {
    // Dependent substreams need channel-set assembly; do not silently discard them.
    if (bsid < 11 || bsid > 16 || b[2] >> 6 !== 0 || ((b[2] >> 3) & 7) !== 0)
      fail("AUDIO_SAMPLE_SUBSTREAM");
    bytes = ((((b[2] & 7) << 8) | b[3]) + 1) * 2;
    const sr = b[4] >> 6,
      code = (b[4] >> 4) & 3;
    rate = sr === 3 ? rates[code] / 2 : rates[sr];
    samples = (sr === 3 ? 6 : [1, 2, 3, 6][code]) * 256;
    if (!Number.isFinite(rate)) fail("AUDIO_SAMPLE_FRAME");
  }
  if (bytes < 7 || bytes > b.length) fail("AUDIO_SAMPLE_FRAME");
  return { bytes, rate, samples };
}
function trackDetails(head, metadata, selection) {
  const audios = metadata.tracks.filter((t) => t.type === 2);
  if (selection?.singleTrack && audios.length !== 1) fail("AUDIO_SAMPLE_SELECTION");
  if (!Number.isSafeInteger(selection?.audioIndex) || selection.audioIndex < 0)
    fail("AUDIO_SAMPLE_SELECTION");
  const track = audios[selection.audioIndex];
  if (
    !track ||
    (selection.streamIndex != null && metadata.tracks[selection.streamIndex] !== track) ||
    (selection.trackNumber != null && track.number !== selection.trackNumber)
  )
    fail("AUDIO_SAMPLE_SELECTION");
  const format = { A_AC3: "ac3", A_EAC3: "eac3", A_AAC: "aac", A_DTS: "dts", A_TRUEHD: "truehd" }[
    track.codecId
  ];
  if (!format) fail("AUDIO_SAMPLE_CODEC");
  const root = media.readElement(head, 0, head.length, true);
  if (!root || root.id !== 0x1a45dfa3) fail("AUDIO_SAMPLE_CONTAINER");
  const segment = media.readElement(head, root.declaredDataEnd, head.length, true);
  let tracks;
  for (let p = segment.dataStart; p < head.length;) {
    const e = media.readElement(head, p, head.length, true);
    if (!e || e.truncated) break;
    if (e.id === 0x1654ae6b) {
      tracks = e;
      break;
    }
    p = e.declaredDataEnd;
  }
  if (!tracks) fail("AUDIO_SAMPLE_TRACKS");
  const entry = children(head, tracks.dataStart, tracks.dataEnd).find((e) => {
    if (e.id !== 0xae) return false;
    return (
      uint(
        head,
        children(head, e.dataStart, e.dataEnd).find((f) => f.id === 0xd7)
      ) === track.number
    );
  });
  const fields = children(head, entry.dataStart, entry.dataEnd);
  if (fields.some((f) => f.id === 0x6d80)) fail("AUDIO_SAMPLE_ENCRYPTED");
  const timestampScale = fields.find((f) => f.id === 0x23314f);
  if (timestampScale) {
    const width = timestampScale.dataEnd - timestampScale.dataStart;
    const scale =
      width === 4
        ? head.readFloatBE(timestampScale.dataStart)
        : width === 8
          ? head.readDoubleBE(timestampScale.dataStart)
          : NaN;
    if (scale !== 1) fail("AUDIO_SAMPLE_TIME_SCALE");
  }
  const codecDelayMs =
    uint(
      head,
      fields.find((f) => f.id === 0x56aa)
    ) / 1e6;
  const prerollMs =
    uint(
      head,
      fields.find((f) => f.id === 0x56bb)
    ) / 1e6;
  if (codecDelayMs > 1000 || prerollMs > 1000) fail("AUDIO_SAMPLE_PREROLL");
  let aac = null;
  if (format === "aac") {
    const data = track.codecPrivate;
    if (data.length < 2) fail("AUDIO_SAMPLE_AAC_CONFIG");
    const object = data[0] >> 3,
      frequency = ((data[0] & 7) << 1) | (data[1] >> 7),
      channels = (data[1] >> 3) & 15;
    // HE-AAC/PCE and non-1024-frame configs need explicit handling, not guessed timing.
    if (object !== 2 || frequency > 12 || channels < 1 || channels > 7 || data[1] & 7)
      fail("AUDIO_SAMPLE_AAC_CONFIG");
    aac = { object, frequency, channels };
  }
  return { track, format, codecDelayMs, prerollMs, aac };
}
async function extractAudioSample(options, context) {
  const { url, selection, positionMs, durationMs = 5000 } = options;
  if (
    !Number.isFinite(positionMs) ||
    positionMs < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 500 ||
    durationMs > 30000
  )
    fail("AUDIO_SAMPLE_WINDOW");
  const range = async (start, end, max) => {
    if (context.cancelled || Date.now() >= context.deadline) fail("AUDIO_SAMPLE_CANCELLED");
    const result = await requestRange(url, start, end, max, 0, context);
    if (context.cancelled || Date.now() >= context.deadline) fail("AUDIO_SAMPLE_CANCELLED");
    return result;
  };
  let header = await range(0, 512 * 1024 - 1, 512 * 1024);
  if (
    header.buffer.length >= 8 &&
    ["ftyp", "moov", "free", "wide"].includes(header.buffer.toString("ascii", 4, 8))
  ) {
    if (!Number.isInteger(selection?.audioIndex) || selection.audioIndex < 0)
      fail("AUDIO_SAMPLE_SELECTION");
    return require("./mp4.cjs").extractMp4AudioSample({ ...options, durationMs }, context, header);
  }
  let metadata;
  try {
    metadata = media.parseHeader(header.buffer, header.totalSize);
  } catch (error) {
    if (header.buffer.length < 512 * 1024) throw error;
    header = await range(0, 2 * 1024 * 1024 - 1, 2 * 1024 * 1024);
    metadata = media.parseHeader(header.buffer, header.totalSize);
  }
  const details = trackDetails(header.buffer, metadata, selection);
  const { track, format, codecDelayMs } = details;
  const scale = metadata.timecodeScaleNs / 1e6;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) fail("AUDIO_SAMPLE_TIME_SCALE");
  const offset = metadata.cuesOffset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= metadata.totalSize)
    fail("AUDIO_SAMPLE_INDEX");
  const probe = await range(offset, Math.min(metadata.totalSize - 1, offset + 65535), 65536);
  const cueElement = media.readElement(probe.buffer, 0, probe.buffer.length, true);
  if (
    !cueElement ||
    cueElement.id !== 0x1c53bb6b ||
    !Number.isSafeInteger(cueElement.totalSize) ||
    cueElement.totalSize > 2 * 1024 * 1024 ||
    offset + cueElement.totalSize > metadata.totalSize
  )
    fail("AUDIO_SAMPLE_INDEX");
  const cueBytes =
    cueElement.totalSize <= probe.buffer.length
      ? probe.buffer
      : (await range(offset, offset + cueElement.totalSize - 1, 2 * 1024 * 1024)).buffer;
  // Bound index complexity before allocating the public cue objects.
  if (children(cueBytes, cueElement.dataStart, cueElement.declaredDataEnd).length > 30000)
    fail("AUDIO_SAMPLE_INDEX");
  const cueTrack = metadata.tracks.find((t) => t.type === 1)?.number ?? track.number;
  const cues = media
    .parseCues(cueBytes, metadata.timecodeScaleNs)
    .filter((c) => c.track === cueTrack);
  const warmup = Math.max(100, details.prerollMs);
  const wantedStart = positionMs - warmup;
  const cue = cues.filter((c) => c.timeMs - codecDelayMs <= Math.max(0, wantedStart)).pop();
  if (!cue) fail("AUDIO_SAMPLE_INDEX");
  let cursor = metadata.segmentDataStart + cue.clusterPosition;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < metadata.segmentDataStart ||
    cursor >= metadata.segmentDataEnd
  )
    fail("AUDIO_SAMPLE_INDEX");
  let windowStart = 0,
    window = header.buffer;
  async function read(start, count) {
    if (
      !Number.isSafeInteger(start) ||
      count < 1 ||
      count > 512 * 1024 ||
      start + count > metadata.segmentDataEnd
    )
      fail("AUDIO_SAMPLE_ELEMENT");
    if (start < windowStart || start + count > windowStart + window.length) {
      windowStart = start;
      window = (
        await range(
          start,
          Math.min(metadata.segmentDataEnd - 1, start + Math.max(count, 32 * 1024) - 1),
          Math.max(count, 32 * 1024)
        )
      ).buffer;
    }
    return window.subarray(start - windowStart, start - windowStart + count);
  }
  async function elementAt(start, limit) {
    const bytes = await read(start, Math.min(16, limit - start));
    const element = media.readElement(bytes, 0, bytes.length, true);
    if (!element || !element.totalSize || start + element.totalSize > limit)
      fail("AUDIO_SAMPLE_ELEMENT");
    return {
      id: element.id,
      start,
      dataStart: start + element.dataStart,
      end: start + element.totalSize
    };
  }
  const input = [];
  let first = null,
    endMs = null,
    rate = null,
    size = 0,
    elements = 0,
    partial = false;
  const canShorten = () => first !== null && endMs >= positionMs + 2000;
  function collect(block, clock) {
    const data = packets(block, { dataStart: 0, dataEnd: block.length });
    if (data.track !== track.number) return;
    let pts = (clock + data.relative) * scale - codecDelayMs;
    for (let packet of data.frames) {
      if (format === "aac") {
        const length = packet.length + 7,
          config = details.aac;
        if (length > 8191) fail("AUDIO_SAMPLE_AAC");
        const adts = Buffer.from([
          255,
          241,
          ((config.object - 1) << 6) | (config.frequency << 2) | (config.channels >> 2),
          ((config.channels & 3) << 6) | (length >> 11),
          (length >> 3) & 255,
          ((length & 7) << 5) | 31,
          252
        ]);
        packet = Buffer.concat([adts, packet]);
      }
      for (let p = 0; p < packet.length;) {
        const info = frameInfo(packet.subarray(p), format);
        if (format === "truehd") {
          if (info.rate) {
            if (info.rate < 44100 || info.rate > 192000) fail("AUDIO_SAMPLE_RATE");
            if (rate !== null && rate !== info.rate) fail("AUDIO_SAMPLE_RATE_CHANGE");
            rate = info.rate;
          }
          if (!rate || (first === null && !info.major)) {
            p += info.bytes;
            continue;
          }
          info.rate = rate;
          info.samples = 40 * (rate / (rate % 44100 === 0 ? 44100 : 48000));
        }
        if (rate !== null && rate !== info.rate) fail("AUDIO_SAMPLE_RATE_CHANGE");
        rate = info.rate;
        const next = pts + (info.samples * 1000) / rate;
        if (next > wantedStart && (first === null || endMs < positionMs + durationMs)) {
          if (endMs !== null && Math.abs(pts - endMs) > Math.max(2, scale * 1.1))
            fail("AUDIO_SAMPLE_DISCONTINUITY");
          if (size + info.bytes > LIMIT || input.length >= 40000) {
            if (canShorten()) {
              partial = true;
              return;
            }
            fail("AUDIO_SAMPLE_INPUT_LIMIT");
          }
          if (first === null) first = pts;
          // Use sample counts rather than accumulating rounded Matroska timestamps.
          endMs = first + ((endMs === null ? 0 : endMs - first) + (info.samples * 1000) / rate);
          size += info.bytes;
          input.push(Buffer.from(packet.subarray(p, p + info.bytes)));
        }
        pts = next;
        p += info.bytes;
      }
    }
  }
  while (
    !partial &&
    cursor < metadata.segmentDataEnd &&
    (endMs === null || endMs < positionMs + durationMs)
  ) {
    if (context.cancelled) fail("AUDIO_SAMPLE_CANCELLED");
    if (++elements > 20000) {
      if (canShorten()) {
        partial = true;
        break;
      }
      fail("AUDIO_SAMPLE_ELEMENT_LIMIT");
    }
    const cluster = await elementAt(cursor, metadata.segmentDataEnd);
    cursor = cluster.end;
    if (cluster.id !== 0x1f43b675) continue;
    let clock = null;
    for (let p = cluster.dataStart; p < cluster.end;) {
      if (++elements > 20000) {
        if (canShorten()) {
          partial = true;
          break;
        }
        fail("AUDIO_SAMPLE_ELEMENT_LIMIT");
      }
      const child = await elementAt(p, cluster.end);
      p = child.end;
      if (child.id === 0xe7)
        clock = uint(await read(child.dataStart, child.end - child.dataStart), {
          dataStart: 0,
          dataEnd: child.end - child.dataStart
        });
      if (child.id !== 0xa3 && child.id !== 0xa0) continue;
      if (clock === null) fail("AUDIO_SAMPLE_TIMECODE");
      if (
        child.id === 0xa3 &&
        blockTrack(await read(child.dataStart, Math.min(8, child.end - child.dataStart))) !==
          track.number
      )
        continue;
      if (child.end - child.dataStart > 512 * 1024) {
        fail("AUDIO_SAMPLE_BLOCK_LIMIT");
      }
      if (child.id === 0xa3)
        collect(await read(child.dataStart, child.end - child.dataStart), clock);
      else {
        const body = await read(child.dataStart, child.end - child.dataStart);
        const fields = children(body, 0, body.length);
        const block = fields.find((f) => f.id === 0xa1);
        if (!block) continue;
        const data = body.subarray(block.dataStart, block.dataEnd);
        if (packets(data, { dataStart: 0, dataEnd: data.length }).track !== track.number) continue;
        if (
          uint(
            body,
            fields.find((f) => f.id === 0x75a2)
          )
        )
          fail("AUDIO_SAMPLE_DISCARD_PADDING");
        collect(data, clock);
      }
      if (partial || (endMs !== null && endMs >= positionMs + durationMs)) break;
    }
  }
  if (first === null || first > positionMs || (!partial && endMs < positionMs + durationMs))
    fail("AUDIO_SAMPLE_INCOMPLETE");
  return {
    input: Buffer.concat(input, size),
    format,
    trackNumber: track.number,
    audioIndex: selection.audioIndex,
    streamIndex: selection.streamIndex,
    language: track.language || "",
    startMs: first,
    endMs,
    sampleRate: rate,
    positionMs,
    durationMs,
    partial,
    networkBytes: context.bytes
  };
}
module.exports = { extractAudioSample, frameInfo, trackDetails };
