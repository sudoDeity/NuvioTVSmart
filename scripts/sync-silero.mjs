// Snapshot a user-owned Rust build. Never compiles or edits the Rust project.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2];
if (!source) throw Error("Usage: npm run sync:silero -- /path/to/silero-rust [--legacy]");
const variant = process.argv.includes("--legacy") ? "legacy" : "modern";
const directory = path.join(root, "assets/silero"),
  target = path.join(directory, variant);
const wasm = await readFile(path.resolve(source, "pkg/silero_rust_bg.wasm"));
const weights = await readFile(path.resolve(source, "models/silero-v6.bin"));
const glue = await readFile(path.resolve(source, "pkg/silero_rust.js"), "utf8");
if (
  !WebAssembly.validate(wasm) ||
  weights.length !== 1238540 ||
  weights.subarray(0, 8).toString() !== "SVAD6F32"
)
  throw Error("Invalid Silero artifacts");
const compiled = await build({
  stdin: { contents: glue, sourcefile: "silero_rust.js", resolveDir: path.resolve(source, "pkg") },
  bundle: true,
  format: "iife",
  globalName: "NuvioSilero",
  target: "chrome56",
  logLevel: "silent",
  write: false
});
const runtime = compiled.outputFiles[0].text;
// Validate the captured JS/WASM/weight trio before replacing a working snapshot.
const context = vm.createContext({
  WebAssembly,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  Float32Array,
  DataView,
  ArrayBuffer,
  binary: wasm
});
vm.runInContext(runtime, context);
await vm.runInContext("NuvioSilero.default({ module_or_path: binary })", context);
const vad = new context.NuvioSilero.WasmVad(weights);
const probability = vad.process_chunk(new Float32Array(512));
vad.reset();
vad.free();
if (!Number.isFinite(probability) || probability < 0 || probability > 1)
  throw Error("Silero ABI validation failed");
let manifest;
try {
  manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
} catch (_) {
  manifest = { abi: 1, sampleRate: 16000, chunkSamples: 512, detectorBiasMs: 100, variants: [] };
}
const modelHash = createHash("sha256").update(weights).digest("hex");
// A new model invalidates variants produced for the previous set of weights.
if (manifest.modelHash !== modelHash) manifest.variants = [];
manifest.modelHash = modelHash;
const biasArgument = process.argv.indexOf("--detector-bias-ms");
if (biasArgument >= 0) {
  const bias = Number(process.argv[biasArgument + 1]);
  if (!Number.isFinite(bias) || bias < 0 || bias > 500)
    throw Error("Detector bias must be between 0 and 500 ms");
  manifest.detectorBiasMs = bias;
}
manifest.variants = manifest.variants
  .filter((v) => v.name !== variant)
  .concat({
    name: variant,
    wasm: variant + "/vad.wasm",
    script: variant + "/vad-runtime.js",
    sha256: createHash("sha256").update(wasm).digest("hex")
  });
manifest.variants.sort((a, b) => (a.name === "modern" ? -1 : b.name === "modern" ? 1 : 0));
manifest.version = createHash("sha256")
  .update(JSON.stringify([manifest.abi, manifest.detectorBiasMs, modelHash, manifest.variants]))
  .digest("hex")
  .slice(0, 24);
await mkdir(target, { recursive: true });
for (const [file, contents] of [
  [path.join(target, "vad-runtime.js"), runtime],
  [path.join(target, "vad.wasm"), wasm],
  [path.join(directory, "model.bin"), weights]
]) {
  await writeFile(file + ".tmp", contents);
  await rename(file + ".tmp", file);
}
await writeFile(
  path.join(directory, "manifest.json.tmp"),
  JSON.stringify(manifest, null, 2) + "\n"
);
await rename(path.join(directory, "manifest.json.tmp"), path.join(directory, "manifest.json"));
console.log(`Silero ${variant} snapshot saved; ABI 1; model ${manifest.version}`);
