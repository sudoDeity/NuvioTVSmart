/* Bounded audio-only analysis. One fixed 32 MiB core, reused between samples. */
const SAMPLE_RATE = 16000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_SECONDS = 30;
const MAX_OUTPUT_BYTES = SAMPLE_RATE * MAX_SECONDS * 2;
const FORMATS = ["dts", "truehd", "aac", "ac3", "eac3"];
// (module (func (result v128) (v128.const i32x4 0 0 0 0)))
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
  10, 22, 1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11
]);
let busy = false;
let core = null;
let variant = "";
let coreBase = "";
let legacyOnly = false;
let output = null;

function removeFiles() {
  if (!core || variant === "simd") return;
  try { core.FS.unlink("/sample-input"); } catch (_) {}
  try { core.FS.unlink("/sample-output"); } catch (_) {}
}
async function load(base, selected) {
  if (core && coreBase === base && variant === selected) return;
  removeFiles();
  core = null;
  output = null;
  variant = selected;
  coreBase = base;
  const assets = base + "/audio-transcode/assets/" + (selected === "simd" ? "simd/" : "");
  importScripts(assets + "ffmpeg-core.js");
  if (selected === "simd") {
    core = await createAudioDecoder({ locateFile: (name) => assets + name });
    return;
  }
  core = await createFFmpegCore({
    mainScriptUrlOrBlob: assets + "ffmpeg-core.js#" +
      btoa(JSON.stringify({ wasmURL: assets + "ffmpeg-core.wasm" }))
  });
  core.setLogger(() => {});
  const device = core.FS.makedev(65, 0);
  core.FS.registerDevice(device, {
    open(stream) { stream.seekable = false; },
    write(_stream, bytes, offset, length) {
      if (!output || output.size + length > MAX_OUTPUT_BYTES) throw new Error("sample-output-limit");
      output.bytes.set(bytes.subarray(offset, offset + length), output.size);
      output.size += length;
      return length;
    }
  });
}
function decode(input, format, durationSeconds) {
  if (variant === "simd") {
    const formats = { aac: 1, ac3: 2, eac3: 3, dts: 4, truehd: 5 };
    const limit = Math.floor(durationSeconds * SAMPLE_RATE + 0.00001);
    core.HEAPU8.set(new Uint8Array(input), core._sample_input());
    const count = core._sample_decode(input.byteLength, formats[format], limit);
    if (count <= 0 || count > limit) throw new Error("sample-decode-failed");
    const start = core._sample_output();
    return core.HEAPU8.slice(start, start + count * 2).buffer;
  }
  // One output allocation, rather than retaining and then joining hundreds of chunks.
  output = { bytes: new Uint8Array(Math.ceil(durationSeconds * SAMPLE_RATE) * 2), size: 0 };
  core.FS.writeFile("/sample-input", new Uint8Array(input), { canOwn: true });
  core.FS.mkdev("/sample-output", 438, core.FS.makedev(65, 0));
  core.reset();
  core.setTimeout(8000);
  // Decode downmix avoids multichannel synthesis where the codec supports it.
  // TrueHD stereo substreams can omit the center channel; request the 5.1
  // presentation instead. AAC retains its layout. Mono rematrix stays normalized.
  const decoderOptions = format === "aac" ? [] :
    ["-downmix", format === "truehd" ? "5.1(side)" : "stereo"];
  if (format === "dts") decoderOptions.push("-core_only", "1");
  const result = core.exec(
    "-xerror", "-err_detect", "explode", "-hide_banner", "-loglevel", "error",
    "-threads", "1", "-probesize", "65536", "-analyzeduration", "100000",
    ...decoderOptions, "-f", format, "-i", "/sample-input", "-map", "0:a:0",
    "-t", String(durationSeconds), "-ac", "1", "-ar", String(SAMPLE_RATE),
    "-af", "aresample=rematrix_maxval=1", "-c:a", "pcm_s16le", "-f", "s16le", "/sample-output"
  );
  if (result !== 0 || !output.size || output.size % 2) throw new Error("sample-decode-failed");
  return output.size === output.bytes.byteLength
    ? output.bytes.buffer : output.bytes.buffer.slice(0, output.size);
}

onmessage = async ({ data }) => {
  if (busy) return;
  busy = true;
  const { id, keepAlive = false } = data || {};
  try {
    const { input, format, durationSeconds = 10, base, forceLegacy = false } = data || {};
    if (!(input instanceof ArrayBuffer) || !input.byteLength || input.byteLength > MAX_INPUT_BYTES)
      throw new Error("sample-input-limit");
    if (!FORMATS.includes(format)) throw new Error("sample-format");
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_SECONDS)
      throw new Error("sample-duration-limit");
    if (typeof base !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base))
      throw new Error("sample-local-service");
    let supportsSIMD = false;
    try { supportsSIMD = WebAssembly.validate(SIMD_PROBE); } catch (_) {}
    const selected = !forceLegacy && !legacyOnly && supportsSIMD ? "simd" : "legacy";
    let pcm;
    try {
      await load(base, selected);
      pcm = decode(input, format, durationSeconds);
    } catch (error) {
      if (selected !== "simd") throw error;
      // Missing assets, compilation failures and a failed optimized decode all
      // retry the original compressed packets once with the compatible core.
      legacyOnly = true;
      await load(base, "legacy");
      pcm = decode(input, format, durationSeconds);
    }
    removeFiles();
    output = null;
    postMessage({
      id, variant, pcm,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      sampleFormat: "s16le",
      durationSeconds: pcm.byteLength / (2 * SAMPLE_RATE)
    }, [pcm]);
  } catch (error) {
    postMessage({ id, variant, error: error instanceof Error ? error.message : "sample-decode-failed" });
    removeFiles();
    core = null;
    output = null;
  } finally {
    busy = false;
    if (!keepAlive) close();
  }
};
