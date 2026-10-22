import { Platform } from "../../platform/index.js";
import { TizenEngineFsService } from "../../platform/tizen/tizenEngineFsService.js";
import { requestWebOsCompanionService } from "../../platform/webos/webosCompanionService.js";

function tizenEndpoint() {
  const url = new URL(TizenEngineFsService.getLocalBaseUrls()[0]);
  url.port = "2715";
  return url.origin;
}

// The handle exists before service startup, so cancellation cannot race a late launch.
export function createSubtitleSyncReferenceRequest({ url, headers = {}, requestId }) {
  let cancelled = false;
  let launched = false;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const cancelRemote = () => {
    if (!launched) return;
    if (Platform.isWebOS()) {
      void requestWebOsCompanionService({
        method: "subtitleSyncCancel",
        parameters: { requestId },
        timeoutMs: 1000
      }).catch(() => {});
    } else if (Platform.isTizen()) {
      void fetch(
        `${tizenEndpoint()}/subtitle-sync-cancel?requestId=${encodeURIComponent(requestId)}`
      ).catch(() => {});
    }
  };
  const promise = (async () => {
    let result;
    if (Platform.isWebOS()) {
      if (cancelled) return null;
      launched = true;
      result = await requestWebOsCompanionService({
        method: "subtitleSyncTimeline",
        parameters: { url, headers, requestId },
        timeoutMs: 8500
      });
      result = result?.payload;
    } else if (Platform.isTizen()) {
      const service = await TizenEngineFsService.ensureStarted({ purpose: "subtitle" });
      if (cancelled || service?.status !== "success") return null;
      launched = true;
      // Sensitive request headers stay in the POST body, never in a URL.
      const response = await fetch(`${tizenEndpoint()}/subtitle-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, requestId, headers }),
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response.ok) return null;
      result = await response.json();
    } else return null;
    if (cancelled || result?.returnValue === false || !Array.isArray(result?.tracks)) return null;
    return result.tracks;
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
      controller?.abort();
      cancelRemote();
    }
  };
}
