import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = path.join(root, "services/webos/runtime/dts");
const decoderRoot = process.env.NUVIO_TEST_DECODER_ROOT || runtime;
const coreSource = fs.readFileSync(path.join(decoderRoot, "ffmpeg-core.js"), "utf8");
const wasmBinary = fs.readFileSync(path.join(decoderRoot, "ffmpeg-core.wasm"));
const workerSource = fs.readFileSync(path.join(runtime, "sample-worker.js"), "utf8");
const base = "http://127.0.0.1:2715";
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "nuvio-audio-samples-"));
const codecs = [
  ["dts", "dca"],
  ["truehd", "truehd"],
  ["aac", "aac"],
  ["ac3", "ac3"],
  ["eac3", "eac3"]
];
function makeFixture(format, codec) {
  const file = path.join(fixtures, "tone." + format);
  const result = spawnSync(
    process.env.FFMPEG || "ffmpeg",
    [
      "-nostdin",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1.2",
      "-ac",
      "2",
      "-c:a",
      codec,
      "-strict",
      "-2",
      "-f",
      format === "aac" ? "adts" : format,
      file
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const data = fs.readFileSync(file);
  return Uint8Array.from(data).buffer;
}
function environment(extra = {}) {
  return vm.createContext({
    self: { location: { href: base + "/audio-transcode/assets/sample-worker.js" } },
    WebAssembly,
    performance,
    console,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    atob,
    btoa,
    ArrayBuffer,
    Uint8Array,
    Error,
    ...extra
  });
}
async function runWorker(input, format, durationSeconds = 0.5) {
  let message;
  const logs = [];
  let heap;
  let imports = 0;
  let closed = false;
  const context = environment({
    postMessage(data, transfer = []) {
      message = structuredClone(data, { transfer });
    },
    close() {
      closed = true;
    },
    importScripts(url) {
      imports++;
      assert.equal(url, base + "/audio-transcode/assets/ffmpeg-core.js");
      vm.runInContext(coreSource, context);
      const factory = context.createFFmpegCore;
      context.createFFmpegCore = async (options) => {
        const core = await factory({ ...options, wasmBinary });
        heap = core.HEAPU8.byteLength;
        const setLogger = core.setLogger;
        core.setLogger = () => setLogger((entry) => logs.push(entry.message));
        return core;
      };
    }
  });
  vm.runInContext(workerSource, context);
  await context.onmessage({ data: { input, format, durationSeconds, base } });
  assert.equal(closed, true);
  return { message, heap, imports, logs };
}
function analyse(buffer) {
  const samples = new DataView(buffer);
  let sum = 0,
    crossings = 0,
    previous = 0;
  for (let i = 0; i < samples.byteLength; i += 2) {
    const value = samples.getInt16(i, true) / 32768;
    sum += value * value;
    if (previous < 0 && value >= 0) crossings++;
    previous = value;
  }
  return {
    rms: Math.sqrt(sum / (buffer.byteLength / 2)),
    hz: crossings / (buffer.byteLength / 32000)
  };
}

for (const [format, codec] of codecs) {
  test(`real WASM decodes ${format} to bounded 16 kHz mono PCM`, async () => {
    const { message, heap, logs } = await runWorker(makeFixture(format, codec), format);
    assert.equal(message.error, undefined, logs.join("\n") || message.error);
    assert.equal(message.sampleFormat, "s16le");
    assert.equal(message.channels, 1);
    assert.equal(message.sampleRate, 16000);
    assert.equal(message.pcm.byteLength, 16000);
    assert.equal(message.durationSeconds, 0.5);
    assert.equal(heap, 32 * 1024 * 1024);
    const { rms, hz } = analyse(message.pcm);
    assert.ok(rms > 0.02 && rms < 0.15, `PCM RMS ${rms}`);
    assert.ok(Math.abs(hz - 440) < 10, `resampled tone frequency ${hz}`);
  });
}
for (const [format, codec] of codecs.slice(0, 2)) {
  test(`existing ${format} to AC3 playback conversion still works`, async () => {
    const context = environment();
    vm.runInContext(coreSource, context);
    const core = await context.createFFmpegCore({ wasmBinary });
    core.setLogger(() => {});
    core.FS.writeFile("/input", new Uint8Array(makeFixture(format, codec)));
    core.reset();
    core.setTimeout(8000);
    assert.equal(
      core.exec(
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-f",
        format,
        "-i",
        "/input",
        "-ar",
        "48000",
        "-c:a",
        "ac3",
        "-b:a",
        "640k",
        "-f",
        "ac3",
        "/output"
      ),
      0
    );
    const ac3 = core.FS.readFile("/output");
    assert.ok(ac3.length > 2560);
    assert.deepEqual([...ac3.slice(0, 2)], [11, 119]);
  });
}
test("worker rejects unsupported, oversized and invalid requests before decoder allocation", async () => {
  for (const [input, format, duration] of [
    [new ArrayBuffer(1), "mp3", 1],
    [new ArrayBuffer(4194305), "aac", 1],
    [new ArrayBuffer(1), "aac", 31],
    [new ArrayBuffer(0), "aac", 1]
  ]) {
    const { message, imports } = await runWorker(input, format, duration);
    assert.ok(message.error);
    assert.equal(imports, 0);
  }
});
test("corrupt compressed input cannot report successful PCM", async () => {
  const { message } = await runWorker(new ArrayBuffer(1000), "aac");
  assert.ok(message.error);
  assert.equal(message.pcm, undefined);
});

const { Platform } = await import("../js/platform/index.js");
const { WebOsLunaService } = await import("../js/platform/webos/webosLunaService.js");
const { decodeWebOsAudioSample } = await import("../js/platform/webos/webosAudioSampleDecoder.js");
let workers = [];
const originalWorker = globalThis.Worker;
const originalPlatform = Platform.isWebOS;
const originalRequest = WebOsLunaService.request;
const originalAvailable = WebOsLunaService.isAvailable;
Platform.isWebOS = () => true;
WebOsLunaService.isAvailable = () => true;
WebOsLunaService.request = async () => ({ returnValue: true, url: base });
globalThis.Worker = class {
  constructor() {
    workers.push(this);
  }
  postMessage(payload, transfer) {
    this.payload = structuredClone(payload, { transfer });
  }
  terminate() {
    this.stopped = true;
  }
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const validResult = () => ({
  pcm: new ArrayBuffer(32000),
  sampleRate: 16000,
  channels: 1,
  sampleFormat: "s16le",
  durationSeconds: 1
});

test("client isolates sample work, preserves input and terminates after completion", async () => {
  const input = new Uint8Array([1, 2, 3]);
  const pending = decodeWebOsAudioSample({ input, format: "aac", durationSeconds: 1 });
  await assert.rejects(decodeWebOsAudioSample({ input, format: "aac" }), /busy/);
  await settle();
  const worker = workers.at(-1);
  assert.deepEqual([...new Uint8Array(worker.payload.input)], [1, 2, 3]);
  assert.equal(input.byteLength, 3);
  worker.onmessage({ data: validResult() });
  assert.equal((await pending).pcm.byteLength, 32000);
  assert.equal(worker.stopped, true);
});
test("client cancellation terminates the worker and ignores late results", async () => {
  const controller = new AbortController();
  const pending = decodeWebOsAudioSample({
    input: new ArrayBuffer(3),
    format: "ac3",
    signal: controller.signal
  });
  await settle();
  const worker = workers.at(-1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(worker.stopped, true);
  worker.onmessage({ data: validResult() });
});
test("client rejects invalid output and releases its busy state", async () => {
  for (const invalid of [{ ...validResult(), sampleRate: 48000 }, { error: "decode-failed" }]) {
    const pending = decodeWebOsAudioSample({ input: new ArrayBuffer(3), format: "dts" });
    await settle();
    const worker = workers.at(-1);
    worker.onmessage({ data: invalid });
    await assert.rejects(pending, /decode failed/);
    assert.equal(worker.stopped, true);
  }
});
test("client wall-clock deadline terminates a stalled worker", async () => {
  const originalTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 10000) {
      expire = callback;
      return undefined;
    }
    return originalTimeout(callback, ms, ...args);
  };
  try {
    const pending = decodeWebOsAudioSample({ input: new ArrayBuffer(3), format: "aac" });
    const rejection = assert.rejects(pending, /timed out/);
    await settle();
    const worker = workers.at(-1);
    expire();
    await rejection;
    assert.equal(worker.stopped, true);
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});

test("already cancelled and unsupported inputs never start a worker", async () => {
  const count = workers.length;
  await assert.rejects(decodeWebOsAudioSample({ input: new ArrayBuffer(1), format: "mp3" }));
  await assert.rejects(
    decodeWebOsAudioSample({
      input: new ArrayBuffer(1),
      format: "aac",
      signal: AbortSignal.abort()
    }),
    { name: "AbortError" }
  );
  assert.equal(workers.length, count);
});

test.after(() => {
  fs.rmSync(fixtures, { recursive: true, force: true });
  globalThis.Worker = originalWorker;
  Platform.isWebOS = originalPlatform;
  WebOsLunaService.request = originalRequest;
  WebOsLunaService.isAvailable = originalAvailable;
});
