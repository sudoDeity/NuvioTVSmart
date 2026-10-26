import { Platform } from "../index.js";
import { requestWebOsCompanionService } from "./webosCompanionService.js";
import { createAudioDecodeRequest } from "../audioSampleDecoder.js";

/** Decode independent elementary-stream packets to 16 kHz mono s16le PCM.
 * AAC needs ADTS headers. The caller retains track and media timestamp identity.
 */
let active = false;
export async function decodeWebOsAudioSample(options = {}) {
  if (options.signal?.aborted)
    throw Object.assign(Error("Audio sample cancelled"), { name: "AbortError" });
  if (!Platform.isWebOS() || typeof Worker !== "function")
    throw Error("Audio sample decoding unavailable");
  if (active) throw Error("Audio sample decoder busy");
  active = true;
  try {
    const health = await requestWebOsCompanionService({ method: "ping", timeoutMs: 2000 });
    const base = String(health?.payload?.url || "").replace(/\/$/, "");
    return await createAudioDecodeRequest({ ...options, base }).promise;
  } finally {
    active = false;
  }
}
