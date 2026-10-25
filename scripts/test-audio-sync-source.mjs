import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { extractAudioSample } = require("../services/shared/audio-sync/audioSampleSource.cjs");
const { requestRange } = require("../services/shared/audio-sync/range.cjs");
const service = require("../services/shared/audio-sync/audioSamples.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nuvio-audio-sync-"));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
function fixture(codec, container) {
  const filename = path.join(temp, `${codec}.${container}`);
  if (!fs.existsSync(filename)) {
    const result = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=32x32:rate=2:duration=6",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=6",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "mpeg4",
        "-g",
        "2",
        "-c:a",
        codec,
        "-strict",
        "-2",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-y",
        filename
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
  }
  return fs.readFileSync(filename);
}
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
function ranged(bytes, observations = []) {
  return (req, res) => {
    observations.push({ range: req.headers.range, authorization: req.headers.authorization });
    const match = String(req.headers.range).match(/^bytes=(\d+)-(\d+)$/);
    if (!match) {
      res.writeHead(400).end();
      return;
    }
    const from = Number(match[1]),
      to = Math.min(Number(match[2]), bytes.length - 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${from}-${to}/${bytes.length}`,
      "Content-Length": to - from + 1
    });
    res.end(bytes.subarray(from, to + 1));
  };
}
function context(base) {
  return {
    origin: base,
    headers: {},
    requests: new Set(),
    bytes: 0,
    maxBytes: 16 * 1024 * 1024,
    requestCount: 0,
    deadline: Date.now() + 10000,
    cancelled: false
  };
}
const root = new URL("../services/webos/runtime/dts/", import.meta.url);
async function decode(sample) {
  return new Promise((resolve, reject) => {
    const env = {
      console,
      WebAssembly,
      ArrayBuffer,
      DataView,
      Uint8Array,
      Int8Array,
      Uint16Array,
      Int16Array,
      Uint32Array,
      Int32Array,
      Float32Array,
      Float64Array,
      TextDecoder,
      TextEncoder,
      setTimeout,
      clearTimeout,
      performance,
      URL,
      atob,
      btoa,
      location: { href: "http://127.0.0.1:9999/audio-transcode/assets/sample-worker.js" },
      postMessage: resolve,
      close() {}
    };
    env.self = env;
    env.globalThis = env;
    const ctx = vm.createContext(env);
    env.importScripts = () => {
      vm.runInContext(fs.readFileSync(new URL("ffmpeg-core.js", root), "utf8"), ctx);
      const original = env.createFFmpegCore;
      env.createFFmpegCore = (options) =>
        original({ ...options, wasmBinary: fs.readFileSync(new URL("ffmpeg-core.wasm", root)) });
    };
    vm.runInContext(fs.readFileSync(new URL("sample-worker.js", root), "utf8"), ctx);
    const bytes = Uint8Array.from(sample.input);
    Promise.resolve(
      env.onmessage({
        data: {
          input: bytes.buffer,
          format: sample.format,
          durationSeconds: Math.min(30, (sample.endMs - sample.startMs) / 1000),
          base: "http://127.0.0.1:9999"
        }
      })
    ).catch(reject);
  });
}
for (const [codec, format, container] of [
  ["ac3", "ac3", "mkv"],
  ["eac3", "eac3", "mkv"],
  ["aac", "aac", "mkv"],
  ["dca", "dts", "mkv"],
  ["truehd", "truehd", "mkv"],
  ["aac", "aac", "mp4"],
  ["ac3", "ac3", "mp4"],
  ["eac3", "eac3", "mp4"]
]) {
  test(`extracts the chosen ${format} track from ${container} and decodes real PCM at its media timestamp`, async () => {
    await withServer(ranged(fixture(codec, container)), async (base) => {
      const sample = await extractAudioSample(
        {
          url: base + "/film",
          selection: { audioIndex: 0, singleTrack: true },
          positionMs: 1000,
          durationMs: 2000
        },
        context(base)
      );
      assert.equal(sample.format, format);
      assert.ok(sample.startMs <= 1000);
      assert.ok(sample.startMs > 500);
      assert.ok(sample.endMs >= 3000);
      const result = await decode(sample);
      assert.equal(result.error, undefined);
      assert.equal(result.sampleRate, 16000);
      assert.equal(result.channels, 1);
      assert.ok(result.durationSeconds >= 2 && result.durationSeconds < 3);
      const pcm = new DataView(result.pcm);
      let sum = 0;
      for (let i = 0; i < pcm.byteLength; i += 2) sum += (pcm.getInt16(i, true) / 32768) ** 2;
      assert.ok(Math.sqrt(sum / (pcm.byteLength / 2)) > 0.01);
    });
  });
}
test("invalid audio selection is rejected instead of guessing another track", async () => {
  await withServer(ranged(fixture("ac3", "mkv")), (base) =>
    assert.rejects(
      extractAudioSample(
        { url: base + "/film", selection: { audioIndex: 1 }, positionMs: 1000, durationMs: 2000 },
        context(base)
      )
    )
  );
});
for (const [codec, format, channels] of [
  ["dca", "dts", 6],
  ["truehd", "truehd", 8]
]) {
  test(`long ${format} windows shorten at whole-frame resource limits and still decode`, async () => {
    const filename = path.join(temp, `long-${format}.mkv`);
    const expression = Array.from(
      { length: channels },
      (_, i) => `0.04*sin(2*PI*${440 + i * 97}*t)`
    ).join("|");
    const made = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=32x32:rate=2:duration=32",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=${expression}:s=48000:d=32:c=${channels === 8 ? "7.1" : "5.1"}`,
        "-c:v",
        "mpeg4",
        "-g",
        "2",
        "-c:a",
        codec,
        "-strict",
        "-2",
        ...(codec === "dca" ? ["-b:a", "1536k"] : []),
        "-y",
        filename
      ],
      { encoding: "utf8" }
    );
    assert.equal(made.status, 0, made.stderr);
    await withServer(ranged(fs.readFileSync(filename)), async (base) => {
      const sample = await extractAudioSample(
        { url: base, selection: { audioIndex: 0 }, positionMs: 1000, durationMs: 28000 },
        context(base)
      );
      assert.equal(sample.partial, true);
      assert.ok(sample.input.length <= 4 * 1024 * 1024);
      assert.ok(sample.endMs >= 3000 && sample.endMs < 29000);
      const pcm = await decode(sample);
      assert.equal(pcm.error, undefined);
      assert.ok(pcm.durationSeconds >= 2);
    });
  });
}
test("large video blocks are skipped rather than downloaded as audio input", async () => {
  const filename = path.join(temp, "large-video.mkv");
  const made = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=size=640x360:rate=12:duration=6,noise=alls=100:allf=t",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=6",
      "-c:v",
      "ffv1",
      "-g",
      "12",
      "-c:a",
      "ac3",
      "-y",
      filename
    ],
    { encoding: "utf8" }
  );
  assert.equal(made.status, 0, made.stderr);
  const bytes = fs.readFileSync(filename);
  assert.ok(bytes.length > 2 * 1024 * 1024);
  await withServer(ranged(bytes), async (base) => {
    const c = context(base);
    const sample = await extractAudioSample(
      { url: base, selection: { audioIndex: 0 }, positionMs: 1000, durationMs: 2000 },
      c
    );
    assert.ok(sample.input.length < 200000);
    assert.ok(sample.networkBytes < bytes.length / 2);
  });
});
test("media servers ignoring Range are rejected before buffering the full movie", async () => {
  await withServer(
    (req, res) => res.end(Buffer.alloc(100000)),
    (base) =>
      assert.rejects(requestRange(base, 0, 100, 101, 0, context(base)), /AUDIO_SAMPLE_RANGE/)
  );
});
test("cross-origin redirect does not forward media credentials", async () => {
  const observations = [];
  await withServer(ranged(Buffer.alloc(100), observations), async (other) => {
    await withServer(
      (req, res) => res.writeHead(302, { Location: other + "/target" }).end(),
      async (base) => {
        const c = context(base);
        c.headers = { Authorization: "private" };
        await requestRange(base, 0, 20, 21, 0, c);
        assert.equal(observations[0].authorization, undefined);
      }
    );
  });
});
test("Tizen HTTP route creates, consumes once and cancels bounded sample requests", async () => {
  await withServer(ranged(fixture("ac3", "mkv")), async (media) => {
    await withServer(
      (req, res) => {
        if (!service.handle(req, res)) res.writeHead(404).end();
      },
      async (base) => {
        const response = await fetch(base + "/audio-sample-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: media,
            requestId: "test-1",
            selection: { audioIndex: 0 },
            positionMs: 1000,
            durationMs: 1000
          })
        });
        assert.equal(response.status, 200);
        const sample = await response.json();
        assert.equal(sample.returnValue, true);
        assert.equal((await fetch(base + sample.path)).status, 200);
        assert.equal((await fetch(base + sample.path)).status, 404);
        service.cancel("test-cancel");
        await assert.rejects(service.create({ url: media, requestId: "test-cancel" }), /CANCELLED/);
        const forbidden = await fetch(base + "/audio-sample-create", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://unrelated.test" },
          body: "{}"
        });
        assert.equal(forbidden.status, 403);
        const oversized = await fetch(base + "/audio-sample-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ padding: "x".repeat(70000) })
        });
        assert.equal(oversized.status, 413);
        const malformed = await fetch(base + "/audio-sample-create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{"
        });
        assert.equal(malformed.status, 400);
      }
    );
  });
});
