/* global NuvioSilero, importScripts */
import { VadStream } from "./vadStream.js";
import { dialogueCues } from "./timeline.js";
import { AudioSyncTracker, retimeAudioCues } from "./tracker.js";
let stream = null,
  tracks = [],
  version = "",
  ready = false,
  processing = false;
async function bytes(url) {
  const response = await fetch(url);
  if (!response.ok && response.status !== 0) throw Error("Model asset unavailable");
  return response.arrayBuffer();
}
async function initialize(data) {
  if (stream) stream.free();
  ready = false;
  const base = new URL("../silero/", self.location.href);
  const manifest = JSON.parse(
    new TextDecoder().decode(await bytes(new URL("manifest.json", base)))
  );
  if (
    manifest.abi !== 1 ||
    manifest.sampleRate !== 16000 ||
    manifest.chunkSamples !== 512 ||
    !Array.isArray(manifest.variants) ||
    manifest.variants.length > 2
  )
    throw Error("Unsupported model ABI");
  let selected = null;
  for (const variant of manifest.variants) {
    if (
      !/^(modern|legacy)\/vad\.wasm$/.test(variant.wasm) ||
      !/^(modern|legacy)\/vad-runtime\.js$/.test(variant.script)
    )
      continue;
    const binary = await bytes(new URL(variant.wasm, base));
    if (WebAssembly.validate(binary)) {
      selected = { variant, binary };
      break;
    }
  }
  if (!selected) throw Error("This TV needs a compatible WASM build");
  importScripts(new URL(selected.variant.script, base).href);
  await NuvioSilero.default({ module_or_path: selected.binary });
  stream = new VadStream(
    new NuvioSilero.WasmVad(new Uint8Array(await bytes(new URL("model.bin", base))))
  );
  tracks = (data.tracks || [])
    .slice(0, 12)
    .map((t) => {
      const cues = dialogueCues(t.cues);
      return {
        id: t.id,
        tracker: new AudioSyncTracker(cues, {
          detectorBiasMs: Number(manifest.detectorBiasMs) || 0
        })
      };
    })
    .filter((t) => t.tracker.cues.length >= 20);
  if (!tracks.length) throw Error("Not enough subtitle dialogue");
  version = manifest.version;
  ready = true;
  postMessage({ type: "ready", version });
}
self.onmessage = async ({ data }) => {
  if (processing) {
    postMessage({ type: "error", error: "busy" });
    return;
  }
  processing = true;
  try {
    if (data.type === "init") await initialize(data);
    else if (data.type === "addTracks" && ready) {
      for (const t of (data.tracks || []).slice(0, 5)) {
        const cues = dialogueCues(t.cues);
        if (cues.length >= 20 && tracks.length < 6 && !tracks.some((x) => x.id === t.id))
          tracks.push({ id: t.id, tracker: new AudioSyncTracker(cues) });
      }
      postMessage({ type: "tracksAdded" });
    } else if (data.type === "adopt" && ready) {
      const track = tracks.find((t) => t.id === data.id);
      if (track && data.mapping?.confirmed && retimeAudioCues([], data.mapping))
        track.tracker.mapping = data.mapping;
      postMessage({ type: "adopted" });
    } else if (data.type === "sample" && ready) {
      // Once the selected subtitle is confirmed, stop re-scoring alternatives
      // on every playback update. Their initial search must not become steady CPU load.
      const owner = tracks.find((t) => t.id === data.selectedId && t.tracker.mapping?.confirmed);
      if (owner) tracks = [owner];
      const timeline = stream.ingest(data.pcm, data.startMs);
      const results = tracks.map((t) => ({
        id: t.id,
        ...t.tracker.update(timeline, data.playbackMs)
      }));
      const confirmed = results
        .filter((r) => r.mapping && r.mapping.confirmed)
        .sort((a, b) => (b.estimate?.peak || 0) - (a.estimate?.peak || 0));
      const selected = results.find((r) => r.id === data.selectedId);
      const selectedTrack = tracks.find((t) => t.id === data.selectedId);
      const ambiguous =
        confirmed.length > 1 &&
        confirmed[0].estimate &&
        confirmed[1].estimate &&
        confirmed[0].estimate.peak - confirmed[1].estimate.peak < 0.08 &&
        (Math.abs(confirmed[0].estimate.shiftMs - confirmed[1].estimate.shiftMs) > 400 ||
          Math.abs(confirmed[0].estimate.scale - confirmed[1].estimate.scale) > 0.002);
      const winner = selectedTrack?.tracker.mapping?.confirmed
        ? selected
        : (!ambiguous && confirmed[0]) || selected;
      postMessage({
        type: "analysis",
        version,
        knownSeconds: timeline.known * 0.032,
        result: winner || null
      });
    } else throw Error("Invalid audio worker request");
  } catch (_) {
    postMessage({ type: "error", error: "audio-analysis-unavailable" });
  } finally {
    processing = false;
  }
};
