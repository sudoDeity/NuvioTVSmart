/* Experimental, one bounded compressed sample per Worker. No playback session I/O. */
const SAMPLE_RATE = 16000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_SECONDS = 30;
const MAX_OUTPUT_BYTES = SAMPLE_RATE * MAX_SECONDS * 2;
const FORMATS = ["dts", "truehd", "aac", "ac3", "eac3"];
let started = false;

onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  let core;
  try {
    const { input, format, durationSeconds = 10, base } = data || {};
    if (!(input instanceof ArrayBuffer) || !input.byteLength || input.byteLength > MAX_INPUT_BYTES)
      throw new Error("sample-input-limit");
    if (!FORMATS.includes(format)) throw new Error("sample-format");
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_SECONDS)
      throw new Error("sample-duration-limit");
    if (typeof base !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base))
      throw new Error("sample-local-service");
    importScripts(base + "/audio-transcode/assets/ffmpeg-core.js");
    core = await createFFmpegCore({
      mainScriptUrlOrBlob:
        base + "/audio-transcode/assets/ffmpeg-core.js#" +
        btoa(JSON.stringify({ wasmURL: base + "/audio-transcode/assets/ffmpeg-core.wasm" }))
    });
    core.setLogger(() => {});
    core.FS.writeFile("/sample-input", new Uint8Array(input));
    const parts = [];
    let size = 0;
    const device = core.FS.makedev(65, 0);
    core.FS.registerDevice(device, {
      open(stream) { stream.seekable = false; },
      write(_stream, bytes, offset, length) {
        if (size + length > MAX_OUTPUT_BYTES) throw new Error("sample-output-limit");
        parts.push(bytes.slice(offset, offset + length));
        size += length;
        return length;
      }
    });
    core.FS.mkdev("/sample-output", 438, device);
    core.reset();
    core.setTimeout(8000);
    const result = core.exec(
      "-xerror", "-err_detect", "explode", "-hide_banner", "-loglevel", "error",
      "-threads", "1", "-probesize", "65536", "-analyzeduration", "100000",
      "-f", format, "-i", "/sample-input", "-map", "0:a:0",
      "-t", String(durationSeconds), "-ac", "1", "-ar", String(SAMPLE_RATE),
      "-af", "aresample=rematrix_maxval=1", "-c:a", "pcm_s16le", "-f", "s16le", "/sample-output"
    );
    if (result !== 0 || !size || size % 2) throw new Error("sample-decode-failed");
    const pcm = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { pcm.set(part, offset); offset += part.length; }
    postMessage({
      pcm: pcm.buffer,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      sampleFormat: "s16le",
      durationSeconds: size / (2 * SAMPLE_RATE)
    }, [pcm.buffer]);
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : "sample-decode-failed" });
  } finally {
    if (core) {
      try { core.FS.unlink("/sample-input"); } catch (_) {}
      try { core.FS.unlink("/sample-output"); } catch (_) {}
    }
    close();
  }
};
