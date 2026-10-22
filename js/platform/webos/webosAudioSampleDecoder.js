import { Platform } from "../index.js";
import { requestWebOsCompanionService } from "./webosCompanionService.js";

const FORMATS = new Set(["dts", "truehd", "aac", "ac3", "eac3"]);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
let active = false;

/** Decode an independent elementary-stream sample; the caller retains timeline/track identity.
 * AAC input must have ADTS headers. Matroska/MP4 files and raw AAC blocks are not accepted.
 * Returns PCM bytes in signed 16-bit little-endian format, mono, 16 kHz.
 */
export function decodeWebOsAudioSample({ input, format, durationSeconds = 10, signal } = {}) {
  const abortError = () =>
    Object.assign(new Error("Audio sample cancelled"), { name: "AbortError" });
  if (signal?.aborted) return Promise.reject(abortError());
  if (!Platform.isWebOS() || typeof Worker !== "function")
    return Promise.reject(new Error("Audio sample decoding unavailable"));
  if (active) return Promise.reject(new Error("Audio sample decoder busy"));
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input) && input.buffer instanceof ArrayBuffer
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
  if (!bytes?.byteLength || bytes.byteLength > MAX_INPUT_BYTES)
    return Promise.reject(new Error("Audio sample input exceeds limit"));
  if (
    !FORMATS.has(format) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > 30
  )
    return Promise.reject(new Error("Unsupported audio sample format or duration"));

  active = true;
  return new Promise((resolve, reject) => {
    let worker;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker?.terminate();
      signal?.removeEventListener("abort", cancel);
      active = false;
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error("Audio sample decoding timed out")), 10000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) return cancel();
    void (async () => {
      const health = await requestWebOsCompanionService({ method: "ping", timeoutMs: 2000 });
      if (done) return;
      const base = String(health?.payload?.url || "").replace(/\/$/, "");
      if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base))
        throw new Error("Local audio service unavailable");
      const url = URL.createObjectURL(
        new Blob(
          [`importScripts(${JSON.stringify(base + "/audio-transcode/assets/sample-worker.js")});`],
          { type: "application/javascript" }
        )
      );
      try {
        worker = new Worker(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      worker.onerror = () => finish(new Error("Audio sample worker failed"));
      worker.onmessage = ({ data }) => {
        if (done) return;
        const size = data?.pcm?.byteLength;
        if (
          data?.error ||
          !(data?.pcm instanceof ArrayBuffer) ||
          !size ||
          size % 2 ||
          size > 960000 ||
          data.sampleRate !== 16000 ||
          data.channels !== 1 ||
          data.sampleFormat !== "s16le" ||
          data.durationSeconds !== size / 32000 ||
          data.durationSeconds > durationSeconds + 0.001
        )
          return finish(new Error("Audio sample decode failed"));
        finish(null, data);
      };
      // Transfer a copy: a failed/cancelled analysis must not detach the caller's packets.
      const copy = bytes.slice().buffer;
      worker.postMessage({ input: copy, format, durationSeconds, base }, [copy]);
    })().catch((error) => finish(error));
  });
}
