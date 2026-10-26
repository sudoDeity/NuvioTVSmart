// One shared, bounded decoder for both TV platforms. Keep its compiled core warm
// between analysis windows; cancellation and 30 seconds of idle time release it.
const FORMATS = new Set(["dts", "truehd", "aac", "ac3", "eac3"]);
const IDLE_MS = 30000;
let worker = null;
let workerBase = "";
let pending = null;
let idleTimer;
let sequence = 0;
let legacyBase = "";
const abortError = () => Object.assign(Error("Audio sample cancelled"), { name: "AbortError" });

function destroy() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  workerBase = "";
}
export function releaseAudioSampleDecoder() {
  if (pending) pending.finish(abortError());
  destroy();
}
export function createAudioDecodeRequest({
  base,
  input,
  format,
  durationSeconds = 10,
  signal
} = {}) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    if (pending) return reject(Error("Audio sample decoder busy"));
    if (typeof Worker !== "function" || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base))
      return reject(Error("Audio sample decoding unavailable"));
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : ArrayBuffer.isView(input) && input.buffer instanceof ArrayBuffer
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : null;
    if (!bytes?.byteLength || bytes.byteLength > 4194304)
      return reject(Error("Audio sample input exceeds limit"));
    if (
      !FORMATS.has(format) ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 30
    )
      return reject(Error("Unsupported audio sample format or duration"));
    clearTimeout(idleTimer);
    if (workerBase !== base) destroy();
    const id = ++sequence;
    let timer;
    let done = false;
    let fallback = legacyBase === base;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      pending = null;
      if (error) {
        destroy();
        reject(error);
      } else {
        // Stored packets are gone after settlement; retain only the bounded core.
        worker.onmessage = null;
        worker.onerror = null;
        idleTimer = setTimeout(destroy, IDLE_MS);
        resolve(result);
      }
    };
    pending = { finish };
    cancel = () => finish(abortError());
    signal?.addEventListener("abort", cancel, { once: true });
    function retry(error) {
      if (done) return;
      if (fallback) return finish(error);
      // A fatal worker error / timeout cannot be recovered inside that worker.
      // Retained source bytes allow one clean restart using the legacy core.
      fallback = true;
      legacyBase = base;
      destroy();
      start();
    }
    function start() {
      clearTimeout(timer);
      timer = setTimeout(() => retry(Error("Audio sample decoding timed out")), 12000);
      try {
        if (!worker) {
          const url = URL.createObjectURL(
            new Blob(
              [
                `importScripts(${JSON.stringify(base + "/audio-transcode/assets/sample-worker.js")});`
              ],
              { type: "application/javascript" }
            )
          );
          try {
            worker = new Worker(url);
          } finally {
            URL.revokeObjectURL(url);
          }
          workerBase = base;
        }
        const activeWorker = worker;
        worker.onerror = () => {
          if (worker === activeWorker) retry(Error("Audio sample worker failed"));
        };
        worker.onmessage = ({ data }) => {
          if (done || worker !== activeWorker || data?.id !== id) return;
          const size = data?.pcm?.byteLength;
          if (data?.error) {
            if (data.variant === "legacy") return finish(Error("Audio sample decode failed"));
            return retry(Error("Audio sample decode failed"));
          }
          if (
            !(data?.pcm instanceof ArrayBuffer) ||
            !size ||
            size % 2 ||
            size > 960000 ||
            data.sampleRate !== 16000 ||
            data.channels !== 1 ||
            data.sampleFormat !== "s16le" ||
            data.durationSeconds !== size / 32000 ||
            data.durationSeconds > durationSeconds + 0.001 ||
            !["simd", "legacy"].includes(data.variant)
          )
            return finish(Error("Audio sample decode failed: invalid PCM"));
          if (data.variant === "legacy") legacyBase = base;
          finish(null, data);
        };
        // Retain the original for a fallback after a fatal worker failure.
        const copy = bytes.slice().buffer;
        worker.postMessage(
          {
            id,
            keepAlive: true,
            forceLegacy: fallback,
            input: copy,
            format,
            durationSeconds,
            base
          },
          [copy]
        );
      } catch (error) {
        retry(error);
      }
    }
    if (signal?.aborted) cancel();
    else start();
  });
  return { promise, cancel: () => cancel() };
}
