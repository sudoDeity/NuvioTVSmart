import { Platform } from "../../platform/index.js";
import { requestWebOsCompanionService } from "../../platform/webos/webosCompanionService.js";
import { TizenEngineFsService } from "../../platform/tizen/tizenEngineFsService.js";
const localBase = (value) => /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(value);
export function createAudioSampleRequest(options) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let cancelled = false,
    launched = false,
    base = "",
    worker = null,
    rejectDecode = null;
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const abortError = () => Object.assign(Error("Audio sampling cancelled"), { name: "AbortError" });
  const cancelRemote = () => {
    if (!launched) return;
    if (Platform.isWebOS())
      void requestWebOsCompanionService({
        method: "audioSampleCancel",
        parameters: { requestId: options.requestId },
        timeoutMs: 1000
      }).catch(() => {});
    else if (base)
      void fetch(base + "/audio-sample-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: options.requestId })
      }).catch(() => {});
  };
  const promise = (async () => {
    let metadata;
    const init = controller ? { signal: controller.signal } : {};
    if (Platform.isWebOS()) {
      const health = await requestWebOsCompanionService({ method: "ping", timeoutMs: 3000 });
      base = String(health?.payload?.url || "").replace(/\/$/, "");
    } else if (Platform.isTizen()) {
      const state = await TizenEngineFsService.ensureStarted({ purpose: "subtitle" });
      if (state?.status !== "success") throw Error("Audio service unavailable");
      const url = new URL(TizenEngineFsService.getLocalBaseUrls()[0]);
      url.port = "2715";
      base = url.origin;
    } else throw Error("Audio sampling unavailable");
    if (cancelled) throw abortError();
    if (!localBase(base)) throw Error("Audio service unavailable");
    launched = true;
    if (Platform.isWebOS()) {
      const response = await requestWebOsCompanionService({
        method: "audioSampleCreate",
        parameters: options,
        timeoutMs: 32000
      });
      metadata = response?.payload;
    } else {
      const response = await fetch(base + "/audio-sample-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
        ...init
      });
      if (!response.ok) throw Error("Audio sampling failed");
      metadata = await response.json();
    }
    if (cancelled) {
      cancelRemote();
      throw abortError();
    }
    if (
      !metadata ||
      metadata.returnValue !== true ||
      metadata.requestId !== options.requestId ||
      !/^\/audio-samples\/[a-f0-9]{48}$/.test(metadata.path) ||
      !Number.isFinite(metadata.startMs) ||
      !Number.isFinite(metadata.endMs) ||
      metadata.endMs <= metadata.startMs ||
      !Number.isInteger(metadata.byteLength) ||
      metadata.byteLength < 1 ||
      metadata.byteLength > 4 * 1024 * 1024 ||
      !["ac3", "eac3", "aac", "dts", "truehd"].includes(metadata.format) ||
      metadata.audioIndex !== options.selection.audioIndex ||
      !Number.isFinite(metadata.networkBytes) ||
      metadata.networkBytes > options.maxBytes
    )
      throw Error("Invalid audio sample metadata");
    const response = await fetch(base + metadata.path, init);
    if (!response.ok) throw Error("Audio sample expired");
    const input = await response.arrayBuffer();
    if (cancelled) throw abortError();
    if (input.byteLength !== metadata.byteLength) throw Error("Truncated audio sample");
    const decoded = await new Promise((resolve, reject) => {
      rejectDecode = reject;
      const durationSeconds = Math.min(30, (metadata.endMs - metadata.startMs) / 1000);
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
      worker.onerror = () => reject(Error("Audio decoder failed"));
      worker.onmessage = ({ data }) => {
        if (
          data?.error ||
          !(data?.pcm instanceof ArrayBuffer) ||
          !data.pcm.byteLength ||
          data.pcm.byteLength % 2 ||
          data.pcm.byteLength > 960000 ||
          data.sampleRate !== 16000 ||
          data.channels !== 1 ||
          data.sampleFormat !== "s16le" ||
          data.durationSeconds !== data.pcm.byteLength / 32000 ||
          data.durationSeconds > durationSeconds + 0.001
        )
          reject(Error("Invalid decoded audio"));
        else resolve(data);
      };
      worker.postMessage({ input, format: metadata.format, durationSeconds, base }, [input]);
    });
    if (cancelled) throw abortError();
    return {
      ...decoded,
      startMs: metadata.startMs,
      audioIndex: metadata.audioIndex,
      networkBytes: metadata.networkBytes
    };
  })();
  const timeout = setTimeout(() => cancel(), 45000);
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    controller?.abort();
    worker?.terminate();
    rejectDecode?.(abortError());
    rejectCancellation(abortError());
    cancelRemote();
  }
  return {
    promise: Promise.race([promise, cancellation]).finally(() => {
      clearTimeout(timeout);
      worker?.terminate();
      rejectDecode = null;
    }),
    cancel
  };
}
