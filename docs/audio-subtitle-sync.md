# Audio subtitle sync for webOS and Tizen

This ports the speech-activity path of NuvioTV Android PRs [#3897](https://github.com/NuvioMedia/NuvioTV/pull/3897) and [#4150](https://github.com/NuvioMedia/NuvioTV/pull/4150) to the shared TV player. The Rust project remains separately owned and developed. Optional word recognition/ASR is outside this implementation.

## Use

Enable **Auto sync subtitles** and **Sync subtitles to audio** in Playback → Subtitles. Embedded subtitle matching gets the first attempt. When it cannot find a reliable reference, the selected source audio is sampled and compared with add-on subtitle dialogue times.

The audio switch defaults to enabled but does nothing while the main Auto sync switch is off. Sampling defaults to Low. All inference and matching happen on the TV. The only network requests retrieve media ranges and subtitle candidates.

- **Off:** no speculative spots; sample near the playhead.
- **Low:** up to three dialogue spots for films at least 20 minutes long; a 75 MB total read budget per subtitle analysis.
- **High:** up to four spots; a 150 MB total read budget.

Spot and subsequent playhead sampling share that budget. Individual windows are at most 28 seconds with room for decoder preroll, at most 32 MiB of network reads, and at most 4 MiB of compressed audio. Only one sample decoder runs at a time. Sampling pauses during known buffering, playback pause, or a known buffer below five seconds. Unknown AVPlay buffer length is not treated as a measured buffer. Loopback sources do not receive speculative spot reads.

## Rust boundary: ABI 1

The integration consumes the existing wasm-bindgen interface:

```js
await init({ module_or_path: wasmBytes });
const vad = new WasmVad(modelBytes);
vad.reset();
const probability = vad.process_chunk(float32Mono512);
vad.free();
```

Required semantics:

- 16,000 Hz, mono Float32 samples, conventionally in `[-1, 1]`.
- Exactly 512 samples per chunk, covering 32 ms.
- Return one finite speech probability in `[0, 1]`.
- Preserve the LSTM/context state between contiguous chunks.
- `reset()` starts an independent audio window; `free()` releases the instance.
- The captured V6 weight file uses `SVAD6F32` and is 1,238,540 bytes. Changing the format requires changing the snapshot validation as well.

No Rust source changes or Rust builds are performed by this repository. To import a completed Rust build:

```sh
npm run sync:silero -- /path/to/silero-rust
npm run build
```

The command captures `pkg/silero_rust.js`, `pkg/silero_rust_bg.wasm`, and `models/silero-v6.bin`, bundles the JS for a classic worker, checks the actual constructor/inference/reset/free interface, and publishes the model manifest last. It copies the captured bytes rather than rereading a WASM file during publication. A model/version change invalidates remembered mappings.

The checked-in snapshot is a development integration fixture. The runtime checks WASM compatibility before loading its JS glue. To add a separately compiled older-TV build with the same ABI:

```sh
npm run sync:silero -- /path/to/legacy-silero-rust --legacy
```

The loader tries Modern first, then Legacy. JS downleveling does not remove WASM SIMD, reference types, bulk memory or multi-value requirements. Providing a suitable Legacy binary is part of the separately maintained Rust build. If neither variant validates, audio sync reports unavailable and manual timing remains available.

The detector-bias calibration is explicit and versioned:

```sh
npm run sync:silero -- /path/to/silero-rust --detector-bias-ms 100
```

100 ms is the inherited Android starting value, not a measured guarantee for V6. Validate it with real dialogue before release. The port does not assume V5 and V6 scores are numerically interchangeable.

## Shared pipeline

`services/shared/audio-sync` performs bounded HTTP Range reads, container parsing, source-track selection, preroll and media timestamp reconstruction. Source credentials are forwarded only to the original origin, including across redirects. Full-file responses to Range requests are rejected. Requests, bytes, element counts, sample counts and deadlines are bounded.

webOS registers `audioSampleCreate`/`audioSampleCancel` on its existing companion service. Tizen adds equivalent local HTTP routes to the existing subtitle service on port 2715. That service also exposes the same checked-in FFmpeg sample-worker assets. Packaging bundles the shared parser for Node 8 and includes its dependencies in the Tizen WGT.

The decoder returns signed 16-bit little-endian PCM at 16 kHz mono. The analysis adapter divides samples by 32768, aligns to the next 32-ms film-time boundary, resets VAD for each independent window and excludes four warmup chunks. Unobserved frames remain unknown, not silence. Incomplete last chunks are not fabricated or padded into evidence.

The persistent analysis worker owns the VAD instance, compact speech timeline and matchers. A generic FFT computes correlation for the Android candidate frame-rate ratios and shifts within ±60 seconds. Confirmation requires at least 60 seconds of known audio, 20 overlapping dialogue cues, 12 seconds of estimated speech, a distinct peak and agreement between disjoint halves. A consistent local opening can lock even when sampled later scenes belong to a different cut. Scene changes require repeated evidence; the change-point search includes older observations rather than simply putting the change at the latest window boundary.

Provisional unit-rate estimates are reversible, remain unconfirmed and are not cached. Confirmed mappings can refine rate/offset and add bounded piecewise scene mappings. Cue text and styling are retained. The displayed effective delay is evaluated at the playhead, including the manual residual once.

Up to five alternative subtitles in the same language can be evaluated, with at most two subtitle downloads at a time. Unknown-language selections do not trigger a broad language search. A replacement is selected only after a confirmed match; the selected URL, attachment generation, player mount, source URL and audio selection must still be current. No ASR or cross-language word bridge is used.

Remembered mappings are profile-scoped, limited to 200 entries and expire after 30 days. Cache identity includes the source, headers, audio selection, subtitle timing and model version. Source URLs and authentication headers are not retained in plaintext cache keys. Only confirmed, structurally valid mappings are stored.

## Supported input

| Container          | Audio             | Restrictions                                                              |
| ------------------ | ----------------- | ------------------------------------------------------------------------- |
| Seekable Matroska  | AC3, EAC3         | Independent EAC3 substream; unsupported dependent substreams are rejected |
| Seekable Matroska  | AAC               | AAC-LC with supported AudioSpecificConfig; ADTS framing is synthesized    |
| Seekable Matroska  | DTS               | Standard big-endian DTS core frames                                       |
| Seekable Matroska  | TrueHD            | Start at a suitable major sync; valid continuous frame timing             |
| Non-fragmented MP4 | AAC-LC, AC3, EAC3 | Complete bounded sample tables; ordinary unit-rate edit lists             |

Matroska requires usable seek Cues, complete track metadata and unencrypted/uncompressed audio track storage. Large unselected SimpleBlock video payloads are skipped; a small range cache avoids reading all of them. MP4 reads only the necessary metadata and audio samples, with sample sizes/chunk offsets evaluated under bounds.

HLS/DASH manifests, encrypted streams, fragmented MP4, unusual AAC configurations, DTS-HD extensions without a usable supported core representation, and complex MP4 edits are not claimed supported. They retain existing playback/subtitles and manual timing. This source-sampling implementation does not reproduce Android's native `MediaCodec`/decoded-PCM tap for every playback container. TV-specific decoder compatibility and throughput still require device validation.

## Verification and release checks

```sh
npm run test:audio-sync
npm run test:audio-sample
npm run test:subtitle-autosync
npm run lint
npm run build
node scripts/package-webos.mjs
node scripts/package-tizen.mjs
```

Source tests generate local MKV/MP4 fixtures using a host `ffmpeg` binary and serve them from temporary loopback test servers. They exercise actual container sampling and the real FFmpeg WASM decoder for the supported format matrix. Matcher tests cover offset/rate, sparse evidence, ambiguity, incorrect subtitles and scene changes. Worker tests load the actual captured Rust WASM through the built Chromium-56 JS bundle, including the unsupported-WASM failure path. Lifecycle tests cover cancellation, model failure, track changes, stale subtitle results and restoration of original timing.

The tests do not establish on-device movie synchronization accuracy or frame-drop behavior. Before distributing, use the final Rust snapshot, supply a Legacy build for any older supported TVs, measure V6 onset calibration, and check real LG and Samsung playback with language switches, seeks, edited cuts and high-bitrate media.

## Attribution

The speech-activity algorithms are ported/adapted from NuvioTV contributors' implementation at Android PR #4150, head `9d72c704681f4307fc3b403cfef6e49e314e89d9`, under the repository's GPL-3.0 license. The PCM decoder builds on the existing NuvioTVSmart branch's FFmpeg WASM work. Silero model weights are MIT licensed; the full notice ships in `assets/silero/LICENSE`. Existing FFmpeg/ffmpeg.wasm notices remain with the decoder assets.
