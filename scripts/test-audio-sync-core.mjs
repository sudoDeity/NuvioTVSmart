import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fft } from "../js/core/player/audioSync/fft.js";
import {
  SpeechTimeline,
  dialogueCues,
  renderDialogue
} from "../js/core/player/audioSync/timeline.js";
import { estimateSpeech, isLockable } from "../js/core/player/audioSync/aligner.js";
import { retimeAudioCues, AudioSyncTracker } from "../js/core/player/audioSync/tracker.js";
import { VadStream } from "../js/core/player/audioSync/vadStream.js";
import { planAudioSpots } from "../js/core/player/audioSync/planner.js";
import { resolveAudioSelection } from "../js/core/player/audioSync/selection.js";
import { audioMappingCache } from "../js/core/player/audioSync/cache.js";

const cues = [];
let cursor = 20,
  seed = 941;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
for (let i = 0; i < 180; i++) {
  cursor += 0.3 + random() * 3;
  const end = cursor + 0.3 + random() * 2.6;
  cues.push({ start: cursor, end, text: `dialogue ${i}` });
  cursor = end;
}
function timeline(
  scale,
  shiftMs,
  ranges = [
    [50000, 190000],
    [300000, 440000]
  ]
) {
  const out = new SpeechTimeline();
  for (const [from, to] of ranges) {
    const frame = Math.ceil(from / 32),
      end = Math.floor(to / 32);
    const rendered = renderDialogue(cues, frame - (shiftMs + 100) / 32, end - frame, scale);
    for (let i = 0; i < rendered.length; i++) out.record(frame + i, 0.04 + rendered[i] * 0.9);
  }
  return out;
}
test("FFT convolution primitives agree with a direct DFT and roundtrip", () => {
  const re = Float64Array.from([1, 4, -2, 0, 3, 7, 0.1, -0.8]),
    original = re.slice(),
    im = new Float64Array(8);
  fft(re, im);
  for (let k = 0; k < 8; k++) {
    let r = 0,
      q = 0;
    for (let i = 0; i < 8; i++) {
      r += original[i] * Math.cos((-2 * Math.PI * k * i) / 8);
      q += original[i] * Math.sin((-2 * Math.PI * k * i) / 8);
    }
    assert.ok(Math.abs(r - re[k]) < 1e-10);
    assert.ok(Math.abs(q - im[k]) < 1e-10);
  }
  fft(re, im, true);
  re.forEach((x, i) => assert.ok(Math.abs(x - original[i]) < 1e-10));
});
for (const [scale, shift] of [
  [1, 2300],
  [1, -4200],
  [25 / 24, 1400],
  [23.976 / 25, -3200]
]) {
  test(`audio matching resolves scale ${scale} and shift ${shift} across unknown gaps`, () => {
    const t = timeline(scale, shift),
      segments = t.segments();
    const estimate = estimateSpeech(segments, cues);
    assert.ok(estimate);
    assert.ok(Math.abs(estimate.shiftMs - shift) < 40, JSON.stringify(estimate));
    assert.ok(Math.abs(estimate.scale - scale) < 0.0001, JSON.stringify(estimate));
    assert.equal(isLockable(estimate, segments, cues), true);
  });
}
test("unknown frames are excluded; overlapping observations replace existing evidence", () => {
  const t = new SpeechTimeline();
  t.record(10, 0);
  t.record(100, 0.8);
  t.record(100, 0.4);
  assert.equal(t.known, 2);
  assert.equal(t.segments().length, 2);
  assert.ok(Math.abs(t.segments()[1].probabilities[0] - 0.4) < 0.01);
  assert.equal(estimateSpeech(t.segments(), cues)?.analysedSeconds, 0.064);
});
test("constant audio and insufficient evidence cannot confirm a mapping", () => {
  assert.equal(
    estimateSpeech([{ fromFrame: 0, probabilities: new Float64Array(3000).fill(0.5) }], cues),
    null
  );
  const t = timeline(1, 2300, [[50000, 70000]]),
    parts = t.segments();
  assert.equal(isLockable(estimateSpeech(parts, cues), parts, cues), false);
});
test("unrelated subtitle rhythm is not accepted", () => {
  const t = timeline(1, 2300),
    wrong = cues.map((c, i) => ({
      ...c,
      start: c.start + (i % 11) * 3,
      end: c.end + (i % 11) * 3
    }));
  assert.equal(isLockable(estimateSpeech(t.segments(), wrong), t.segments(), wrong), false);
});
test("tracker confirms strong evidence once and leaves an unchanged timeline alone", () => {
  const t = timeline(1, 2300),
    tracker = new AudioSyncTracker(cues);
  const result = tracker.update(t, 440000);
  assert.equal(result.status, "locked");
  assert.equal(result.mapping.confirmed, true);
  assert.equal(tracker.update(t, 440000).mapping, null);
});
test("tracker locates a later scene edit using both earlier and later evidence", () => {
  const t = timeline(1, 2300, [[60000, 220000]]),
    tracker = new AudioSyncTracker(cues);
  assert.equal(tracker.update(t, 220000).status, "locked");
  function append(from, to) {
    const next = timeline(1, 8300, [[from, to]]);
    for (const s of next.segments())
      s.probabilities.forEach((p, i) => t.record(s.fromFrame + i, p));
  }
  append(240000, 430000);
  assert.equal(tracker.update(t, 430000).mapping, null);
  append(430000, 450000);
  const result = tracker.update(t, 450000);
  assert.equal(result.status, "refined");
  assert.equal(result.mapping.segments.length, 2);
  assert.ok(
    result.mapping.segments[1].fromMediaMs >= 220000 &&
      result.mapping.segments[1].fromMediaMs < 250000
  );
  assert.ok(Math.abs(result.mapping.segments[1].shiftMs - 8300) < 40);
});
test("conflicting samples from a later cut do not prevent a consistent local opening from locking", () => {
  const t = timeline(1, 2300, [[60000, 220000]]),
    later = timeline(1, 8300, [[400000, 560000]]);
  for (const s of later.segments()) s.probabilities.forEach((p, i) => t.record(s.fromFrame + i, p));
  const result = new AudioSyncTracker(cues).update(t, 200000);
  assert.equal(result.status, "locked");
  assert.ok(Math.abs(result.mapping.segments[0].shiftMs - 2300) < 40);
});
test("piecewise retiming respects scene boundaries and preserves cue styling", () => {
  const mapping = {
    confirmed: true,
    segments: [
      { fromMediaMs: 0, scale: 1, shiftMs: 2000 },
      { fromMediaMs: 100000, scale: 1, shiftMs: 5000 }
    ]
  };
  const result = retimeAudioCues(
    [
      { start: 10, end: 12, text: "A", style: { italic: true } },
      { start: 120, end: 123, text: "B" }
    ],
    mapping
  );
  assert.equal(result[0].start, 12);
  assert.equal(result[1].start, 125);
  assert.equal(result[0].style.italic, true);
  assert.equal(
    retimeAudioCues([], { segments: [{ fromMediaMs: 0, scale: NaN, shiftMs: 0 }] }),
    null
  );
});
test("dialogue filtering removes sound and music captions", () => {
  assert.equal(
    dialogueCues([
      { start: 1, end: 2, text: "[door slams]" },
      { start: 3, end: 4, text: "♪ song ♪" },
      { start: 5, end: 6, text: "hello" }
    ]).length,
    1
  );
});
test("sampling avoids credits, spreads windows and stays inside the film", () => {
  const spots = planAudioSpots(cues, 1800000, 3);
  assert.equal(spots.length, 3);
  assert.equal(new Set(spots).size, 3);
  assert.ok(spots.every((s) => s >= 180000 && s + 28000 <= 1440000));
  assert.deepEqual(planAudioSpots(cues, 600000, 3), []);
});
test("AVPlay indexes are resolved to audio ordinals; ambiguous native selections are rejected", () => {
  assert.deepEqual(
    resolveAudioSelection(
      [{ selected: true, avplayAudioTrackIndex: 7 }],
      [{ avplayTrackIndex: 2 }, { avplayTrackIndex: 7 }]
    ),
    { audioIndex: 1 }
  );
  assert.equal(resolveAudioSelection([{ selected: true }, {}]), null);
  assert.deepEqual(resolveAudioSelection([{ selected: true }]), {
    audioIndex: 0,
    singleTrack: true
  });
});
test("cache persists confirmed mappings only and does not retain source credentials", () => {
  const values = new Map(),
    storage = { getItem: (k) => values.get(k), setItem: (k, v) => values.set(k, v) };
  const cache = audioMappingCache("profile", storage),
    key = "https://media.test/private?token=secret";
  const mapping = { confirmed: true, segments: [{ fromMediaMs: 0, scale: 1, shiftMs: 2300 }] };
  cache.set(key, { ...mapping, confirmed: false });
  assert.equal(cache.get(key), null);
  cache.set(key, mapping);
  assert.deepEqual(cache.get(key), mapping);
  assert.ok(![...values.values()][0].includes("secret"));
  assert.equal(audioMappingCache("other", storage).get(key), null);
});
test("PCM adapter aligns to the media grid, resets each window, ignores warmup and normalizes signed samples", () => {
  let resets = 0;
  const seen = [];
  const stream = new VadStream({
    reset() {
      resets++;
    },
    process_chunk(c) {
      seen.push(c[0]);
      return 0.8;
    },
    free() {}
  });
  const pcm = new ArrayBuffer(512 * 10 * 2),
    view = new DataView(pcm);
  for (let i = 0; i < pcm.byteLength; i += 2) view.setInt16(i, -32768, true);
  stream.ingest(pcm, 7);
  assert.equal(resets, 1);
  assert.equal(seen[0], -1);
  assert.equal(stream.timeline.known, 5);
  assert.equal(stream.timeline.segments()[0].fromFrame, 5);
  stream.ingest(pcm, 7);
  assert.equal(resets, 2);
  assert.equal(stream.timeline.known, 5);
});
test("bundled actual Rust WASM loads through the classic-worker ABI and produces finite probabilities", async () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../assets/silero/manifest.json", import.meta.url))
  );
  const dir = new URL("../assets/silero/", import.meta.url),
    variant = manifest.variants[0];
  const context = vm.createContext({
    WebAssembly,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Float32Array,
    DataView,
    ArrayBuffer,
    console
  });
  vm.runInContext(fs.readFileSync(new URL(variant.script, dir), "utf8"), context);
  context.binary = fs.readFileSync(new URL(variant.wasm, dir));
  await vm.runInContext("NuvioSilero.default({ module_or_path: binary })", context);
  const vad = new context.NuvioSilero.WasmVad(fs.readFileSync(new URL("model.bin", dir)));
  const p = vad.process_chunk(new Float32Array(512));
  vad.reset();
  assert.ok(Number.isFinite(p) && p >= 0 && p <= 1);
  assert.equal(vad.process_chunk(new Float32Array(512)), p);
  vad.free();
});
