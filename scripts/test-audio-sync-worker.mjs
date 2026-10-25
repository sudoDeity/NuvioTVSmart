import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const built = await build({
  entryPoints: [path.join(root, "js/core/player/audioSync/worker.js")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome56",
  write: false
});
const source = built.outputFiles[0].text;
function environment({ compatible = true } = {}) {
  const messages = [],
    loaded = [];
  const env = {
    console,
    URL,
    WebAssembly: compatible
      ? WebAssembly
      : {
          validate() {
            return false;
          }
        },
    ArrayBuffer,
    Uint8Array,
    Float32Array,
    Float64Array,
    DataView,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    location: { href: "https://app.test/assets/runtime/audio-sync-worker.js" },
    postMessage(data) {
      messages.push(data);
    }
  };
  env.self = env;
  const context = vm.createContext(env);
  const asset = (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://app.test");
    assert.ok(parsed.pathname.startsWith("/assets/silero/"));
    return path.join(root, parsed.pathname);
  };
  env.fetch = async (url) => {
    const b = fs.readFileSync(asset(url));
    return {
      ok: true,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    };
  };
  env.importScripts = (url) => {
    loaded.push(url);
    vm.runInContext(fs.readFileSync(asset(url), "utf8"), context);
  };
  vm.runInContext(source, context);
  return { messages, loaded, send: (data) => env.onmessage({ data }) };
}
const tracks = [
  {
    id: "selected",
    cues: Array.from({ length: 25 }, (_, i) => ({
      start: i * 4,
      end: i * 4 + 2,
      text: `Line ${i}`
    }))
  }
];
test("Chromium-56 worker bundle loads actual Rust glue and WASM and processes PCM", async () => {
  const e = environment();
  await e.send({ type: "init", tracks });
  assert.equal(e.messages[0].type, "ready");
  assert.equal(e.loaded.length, 1);
  await e.send({
    type: "sample",
    pcm: new ArrayBuffer(32000),
    startMs: 1000,
    playbackMs: 2000,
    selectedId: "selected"
  });
  assert.equal(e.messages[1].type, "analysis");
  assert.ok(e.messages[1].knownSeconds > 0.8 && e.messages[1].knownSeconds < 1);
  assert.equal(e.messages[1].result.status, "collecting");
  assert.equal(e.messages[1].result.mapping, null);
});
test("unsupported WASM on an older TV reports failure before loading incompatible glue", async () => {
  const e = environment({ compatible: false });
  await e.send({ type: "init", tracks });
  assert.equal(e.messages[0].type, "error");
  assert.equal(e.loaded.length, 0);
});
test("worker rejects malformed PCM without emitting a successful mapping", async () => {
  const e = environment();
  await e.send({ type: "init", tracks });
  await e.send({ type: "sample", pcm: new ArrayBuffer(3), startMs: 0 });
  assert.equal(e.messages.at(-1).type, "error");
});
