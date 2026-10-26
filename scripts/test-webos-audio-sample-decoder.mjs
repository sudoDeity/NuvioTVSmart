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
async function runWorker(input, format, durationSeconds = 0.5, variant = "legacy", options = {}) {
  let message;
  const logs = [];
  let heap;
  let imports = 0;
  let closed = false;
  const context = environment({
    WebAssembly: options.noSIMD
      ? Object.assign(Object.create(WebAssembly), { validate: () => false })
      : WebAssembly,
    postMessage(data, transfer = []) {
      message = structuredClone(data, { transfer });
    },
    close() {
      closed = true;
    },
    importScripts(url) {
      imports++;
      const simd = url === base + "/audio-transcode/assets/simd/ffmpeg-core.js";
      assert.ok(simd || url === base + "/audio-transcode/assets/ffmpeg-core.js");
      if (simd && options.failSIMD === "load") throw Error("SIMD asset unavailable");
      vm.runInContext(
        simd ? fs.readFileSync(path.join(runtime, "simd/ffmpeg-core.js"), "utf8") : coreSource,
        context
      );
      const factory = simd ? context.createAudioDecoder : context.createFFmpegCore;
      const factoryName = simd ? "createAudioDecoder" : "createFFmpegCore";
      context[factoryName] = async (coreOptions) => {
        const core = await factory({
          ...coreOptions,
          wasmBinary: simd
            ? fs.readFileSync(path.join(runtime, "simd/ffmpeg-core.wasm"))
            : wasmBinary
        });
        if (simd && options.failSIMD === "decode") core._sample_decode = () => -1;
        heap = core.HEAPU8.byteLength;
        if (core.setLogger) {
          const setLogger = core.setLogger;
          core.setLogger = () => setLogger((entry) => logs.push(entry.message));
        }
        return core;
      };
    }
  });
  vm.runInContext(workerSource, context);
  await context.onmessage({
    data: {
      input,
      format,
      durationSeconds,
      base,
      forceLegacy: variant === "legacy",
      keepAlive: !!options.keepAlive
    }
  });
  assert.equal(closed, !options.keepAlive);
  return {
    context,
    logs,
    get message() {
      return message;
    },
    get heap() {
      return heap;
    },
    get imports() {
      return imports;
    }
  };
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

for (const variant of ["legacy", "simd"]) {
  for (const [format, codec] of codecs) {
    test(`real ${variant} WASM decodes ${format} to bounded 16 kHz mono PCM`, async () => {
      const { message, heap, logs } = await runWorker(
        makeFixture(format, codec),
        format,
        0.5,
        variant
      );
      assert.equal(message.error, undefined, logs.join("\n") || message.error);
      assert.equal(message.variant, variant, `${format} selected ${message.variant}`);
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
}
for (const failSIMD of ["load", "decode"]) {
  test(`failed SIMD ${failSIMD} retries the same real packets with the legacy core`, async () => {
    const input = makeFixture("aac", "aac");
    const h = await runWorker(input, "aac", 0.5, "auto", { failSIMD, keepAlive: true });
    assert.equal(h.message.error, undefined, h.logs.join("\n"));
    assert.equal(h.message.variant, "legacy");
    assert.equal(h.imports, 2);
    assert.equal(h.message.pcm.byteLength, 16000);
    assert.ok(analyse(h.message.pcm).rms > 0.02);
    await h.context.onmessage({
      data: { input, format: "aac", durationSeconds: 0.5, base, keepAlive: true }
    });
    assert.equal(h.message.variant, "legacy");
    assert.equal(h.imports, 2);
  });
}
test("an engine without SIMD selects only the actual legacy core", async () => {
  const h = await runWorker(makeFixture("ac3", "ac3"), "ac3", 0.5, "auto", { noSIMD: true });
  assert.equal(h.message.error, undefined);
  assert.equal(h.message.variant, "legacy");
  assert.equal(h.imports, 1);
});
for (const variant of ["legacy", "simd"]) {
  test(`${variant} core survives 40 sequential mixed-codec windows without retained sample files`, async () => {
    const inputs = codecs.map(([format, codec]) => [format, makeFixture(format, codec)]);
    const h = await runWorker(inputs[0][1], inputs[0][0], 0.1, variant, { keepAlive: true });
    for (let i = 0; i < 40; i++) {
      const [format, input] = inputs[i % inputs.length];
      await h.context.onmessage({
        data: {
          id: i,
          input,
          format,
          durationSeconds: 0.1,
          base,
          keepAlive: true,
          forceLegacy: variant === "legacy"
        }
      });
      assert.equal(h.message.error, undefined, h.logs.join("\n"));
      assert.equal(h.message.id, i);
      assert.equal(h.message.variant, variant, `${i} ${format} selected ${h.message.variant}`);
      assert.equal(h.message.pcm.byteLength, 3200);
      assert.ok(analyse(h.message.pcm).rms > 0.02);
      assert.equal(h.heap, 33554432);
    }
    assert.equal(h.imports, 1);
    if (variant === "simd") assert.equal(vm.runInContext("core.FS", h.context), undefined);
    assert.throws(() => vm.runInContext('core.FS.stat("/sample-input")', h.context));
    assert.throws(() => vm.runInContext('core.FS.stat("/sample-output")', h.context));
  });
}
for (const [format, codec, layout = "5.1"] of [...codecs, ["truehd", "truehd", "7.1"]]) {
  test(`multichannel ${layout} ${format} retains center-channel bursts and silence identically in SIMD and legacy`, async () => {
    const file = path.join(fixtures, "center-" + layout + "." + format);
    const generation = spawnSync(
      process.env.FFMPEG || "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc='0|0|0.15*sin(2*PI*440*t)*(between(t,0.15,0.4)+between(t,0.7,1))|0|0|0${layout === "7.1" ? "|0|0" : ""}':s=48000:d=1.2:c=${layout}`,
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
    assert.equal(generation.status, 0, generation.stderr);
    const input = Uint8Array.from(fs.readFileSync(file)).buffer;
    const legacy = await runWorker(input, format, 1.2, "legacy");
    const simd = await runWorker(input, format, 1.2, "simd");
    assert.equal(legacy.message.error, undefined, legacy.logs.join("\n"));
    assert.equal(simd.message.error, undefined, simd.logs.join("\n"));
    assert.equal(simd.message.variant, "simd", `${format} unexpectedly fell back`);
    const l = new Int16Array(legacy.message.pcm),
      r = new Int16Array(simd.message.pcm);
    assert.equal(l.length, 19200);
    let maxError = 0;
    for (let i = 0; i < l.length; i++) maxError = Math.max(maxError, Math.abs(l[i] - r[i]));
    assert.ok(maxError <= 2, `SIMD PCM error ${maxError}`);
    for (const [from, to] of [
      [0.25, 0.35],
      [0.8, 0.9]
    ])
      assert.ok(
        analyse(simd.message.pcm.slice(from * 32000, to * 32000)).rms > 0.01,
        `${format} center RMS ${analyse(simd.message.pcm.slice(from * 32000, to * 32000)).rms}`
      );
    assert.ok(analyse(simd.message.pcm.slice(0.5 * 32000, 0.6 * 32000)).rms < 0.001);
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
const { createAudioDecodeRequest, releaseAudioSampleDecoder } =
  await import("../js/platform/audioSampleDecoder.js");
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
    this.lateMessage = this.onmessage;
  }
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const validResult = () => ({
  id: workers.at(-1).payload.id,
  variant: "simd",
  pcm: new ArrayBuffer(32000),
  sampleRate: 16000,
  channels: 1,
  sampleFormat: "s16le",
  durationSeconds: 1
});

test("client preserves input and reuses the same warm worker for subsequent samples", async () => {
  const input = new Uint8Array([1, 2, 3]);
  const pending = decodeWebOsAudioSample({ input, format: "aac", durationSeconds: 1 });
  await assert.rejects(decodeWebOsAudioSample({ input, format: "aac" }), /busy/);
  await settle();
  const worker = workers.at(-1);
  assert.deepEqual([...new Uint8Array(worker.payload.input)], [1, 2, 3]);
  assert.equal(input.byteLength, 3);
  worker.onmessage({ data: validResult() });
  assert.equal((await pending).pcm.byteLength, 32000);
  assert.equal(worker.stopped, undefined);
  const count = workers.length;
  const again = decodeWebOsAudioSample({ input, format: "aac", durationSeconds: 1 });
  await settle();
  assert.equal(workers.length, count);
  assert.equal(worker.payload.keepAlive, true);
  worker.onmessage({ data: validResult() });
  await again;
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
  worker.lateMessage({ data: validResult() });
});
test("client rejects invalid output and releases its busy state", async () => {
  for (const invalid of [
    { ...validResult(), sampleRate: 48000 },
    { error: "decode-failed", variant: "legacy" }
  ]) {
    const pending = decodeWebOsAudioSample({ input: new ArrayBuffer(3), format: "dts" });
    await settle();
    const worker = workers.at(-1);
    worker.onmessage({ data: { ...invalid, id: worker.payload.id } });
    await assert.rejects(pending, /decode failed/);
    assert.equal(worker.stopped, true);
  }
});
test("fatal worker failure restarts once with original packets and ignores a late fast result", async () => {
  const input = new Uint8Array([7, 8, 9]);
  const request = createAudioDecodeRequest({ base, input, format: "aac", durationSeconds: 1 });
  const fast = workers.at(-1);
  const late = fast.onmessage;
  fast.onerror();
  const fallback = workers.at(-1);
  assert.notEqual(fallback, fast);
  assert.equal(fast.stopped, true);
  assert.equal(fallback.payload.forceLegacy, true);
  assert.deepEqual([...new Uint8Array(fallback.payload.input)], [7, 8, 9]);
  assert.equal(input.byteLength, 3);
  late({ data: { ...validResult(), variant: "simd" } });
  fallback.onmessage({ data: { ...validResult(), variant: "legacy" } });
  assert.equal((await request.promise).variant, "legacy");
  releaseAudioSampleDecoder();
});
test("idle deadline and explicit release dispose the warm core", async () => {
  const originalTimeout = globalThis.setTimeout;
  let idle;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 30000) {
      idle = callback;
      return undefined;
    }
    return originalTimeout(callback, ms, ...args);
  };
  try {
    const request = createAudioDecodeRequest({
      base,
      input: new ArrayBuffer(3),
      format: "aac",
      durationSeconds: 1
    });
    const worker = workers.at(-1);
    worker.onmessage({ data: validResult() });
    await request.promise;
    assert.equal(worker.stopped, undefined);
    idle();
    assert.equal(worker.stopped, true);
    const again = createAudioDecodeRequest({ base, input: new ArrayBuffer(3), format: "ac3" });
    const rejection = assert.rejects(again.promise, { name: "AbortError" });
    releaseAudioSampleDecoder();
    await rejection;
    assert.equal(workers.at(-1).stopped, true);
  } finally {
    globalThis.setTimeout = originalTimeout;
  }
});
test("client wall-clock deadline terminates a stalled worker", async () => {
  const originalTimeout = globalThis.setTimeout;
  let expire;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 12000) {
      expire = callback;
      return undefined;
    }
    return originalTimeout(callback, ms, ...args);
  };
  try {
    const pending = createAudioDecodeRequest({
      base: "http://127.0.0.1:2716",
      input: new ArrayBuffer(3),
      format: "aac"
    }).promise;
    const rejection = assert.rejects(pending, /timed out/);
    await settle();
    const worker = workers.at(-1);
    expire();
    const fallback = workers.at(-1);
    assert.notEqual(worker, fallback);
    assert.equal(fallback.payload.forceLegacy, true);
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
  releaseAudioSampleDecoder();
  fs.rmSync(fixtures, { recursive: true, force: true });
  globalThis.Worker = originalWorker;
  Platform.isWebOS = originalPlatform;
  WebOsLunaService.request = originalRequest;
  WebOsLunaService.isAvailable = originalAvailable;
});
