This optional module decodes DTS or TrueHD and encodes AC3 inside a dedicated browser Worker. Video never enters FFmpeg. There are no native binaries, threads, SIMD, BigInt integration, or external servers. The WASM module validates against the WebAssembly MVP and has a fixed 32 MiB memory; the service limits source clusters to 8 MiB and retained media buffers to 24 MiB. A CPU budget stops decoding that needs more than 65% of the audio's elapsed time (after the first two seconds). Failed streams retain the original selected audio track without repeated attempts.

The implementation supports seekable Matroska with video Cues, SimpleBlock DTS or TrueHD frames, uncompressed/unencrypted track metadata, 48 kHz audio and at most eight source channels. Mono, stereo and standard layouts up to 5.1 retain their channel count. Six- and seven-point-one sources request the source decoder's 5.1(side) downmix and are encoded as six-channel AC3; rematrixing uses a maximum value of 1 to avoid clipping. The projected Matroska header declares six output channels without changing element sizes or seek offsets. Unsupported formats, insufficient padding space, discontinuities, memory limits, decode errors or insufficient performance stop conversion. Compatibility with older webOS models is conditional on their actual performance and native AC3/MKV playback; only the LG G5 has been tested physically.

`ffmpeg-core.js` and `ffmpeg-core.wasm` are built from FFmpeg 5.1.4 (LGPL 2.1 or later) and the MIT licensed ffmpeg.wasm bindings. Copies of both licenses accompany the binaries. Complete corresponding upstream sources are pinned to:

- https://github.com/FFmpeg/FFmpeg/tree/4729204c17f756e186d622060088371d10b34f7e
- https://github.com/ffmpegwasm/ffmpeg.wasm/tree/f876f907c7e9b9bf51d4ed0b913a855a63ae63fc

All build flags and the only C source modification are in `scripts/build-webos-dts.sh`. Activate Emscripten 3.1.40, then run that script to rebuild/relink the module. The C patch changes the millisecond timeout argument to 32 bits to avoid requiring WebAssembly BigInt integration. Binaryen lowers sign-extension instructions and strips target feature metadata. The production app uses the provided prebuilt files; a normal app build does not download a compiler or source code.

TrueHD is restricted to 48 kHz access units (40 samples), with at most 16,384 packets per source cue range. Consecutive selected audio blocks share a bounded output slot, leaving every other element at its original byte offset. Small slots defer AC3 frames to the next slot within the same cue range; insufficient total space stops conversion rather than dropping audio. Each seek generation starts at its first TrueHD major sync and anchors output to that packet timestamp; subsequent ranges retain the continuous decoder. Atmos metadata is not retained. The real LG G5 sample decoded 7.1 seconds in about 1.35 seconds at 32 MiB WASM memory; this is a sample measurement, not a guarantee for other files or TV models.

DTS and TrueHD use the same selection, encoder, playback session, seek generations, memory/CPU budgets and failure policy. Both require every expected AC3 frame to fit before a converted range is served. Only source packet parsing, TrueHD major-sync alignment and small-block grouping differ by codec.


## Experimental audio sample decoder

The same rebuilt FFmpeg core also supports AAC (ADTS), AC3 and EAC3 decoding and
signed 16-bit little-endian PCM output. `sample-worker.js` is a separate, one-shot
worker; it never creates/stops an `audioTranscode` playback session or remuxes the
playing movie. The original `worker.js` continues to produce AC3 for playback.
The decoder remains single-threaded, without SIMD, with fixed 32 MiB WASM memory.
The checked-in binary must be rebuilt together with its JS glue when changing flags.
The build accepts `NUVIO_DTS_OUTPUT` for staging output before replacing runtime files.

`decodeWebOsAudioSample` in `js/platform/webos/webosAudioSampleDecoder.js` accepts
an `ArrayBuffer` or typed-array view plus `format` (`dts`, `truehd`, `aac`, `ac3`,
`eac3`), an optional `durationSeconds` (default 10, maximum 30), and an optional
`AbortSignal`. It uses the existing companion-service ping to locate loopback
assets. Only one sample request can run through this interface at a time.

```js
const sample = await decodeWebOsAudioSample({
  input: compressedAudioPackets,
  format: "aac", // A complete ADTS elementary stream, not raw AAC blocks.
  durationSeconds: 5,
  signal: controller.signal
});
// sample.pcm: ArrayBuffer of signed 16-bit little-endian mono samples at 16000 Hz.
// sample.durationSeconds describes the actual decoded output duration.
```

Input is limited to 4 MiB. Output is limited to 960,000 bytes (30 seconds at
16 kHz mono). The FFmpeg execution budget is 8 seconds; the client terminates
its worker after a 10-second total wall-clock deadline, on abort, on error and
after completion. Input bytes are copied before transfer, preserving the
caller's source packets on cancellation/failure. Decoder errors produce no PCM
success result. A copied PCM result is transferred back once; input/output files
are removed and the worker closes. The 32 MiB figure applies to each WASM heap,
not total browser memory; JS input/output buffers add overhead.

This is only the decoder foundation. It does not extract audio from full MKV/MP4
files, wrap Matroska AAC packets in ADTS, find TrueHD major-sync boundaries,
select the playing track, reconstruct timestamps, or run VAD/ASR. The caller
must supply independently decodable audio packets and retain the sample's
track/timeline identity. No automatic subtitle timing behavior or UI is added.
Root access and external inference servers are not required by this decoder.

Development smoke checks require a host `ffmpeg` executable with AAC/AC3/EAC3,
DTS and TrueHD encoders (the last two are experimental). Run
`npm run test:audio-sample`. Checks generate short synthetic 440 Hz fixtures,
decode all five formats with the actual WASM worker, verify PCM format,
duration, signal amplitude and resampled frequency, and verify the existing
DTS/TrueHD-to-AC3 path. Client checks cover busy rejection, retained input,
cancellation, malformed results and wall-clock termination. These are local
functional checks; actual TV performance requires a device measurement.

A prototype device check on an LG G4 (webOS SDK 10.3.1, 2026-10-22) decoded
one second from each synthetic 48 kHz stereo 440 Hz fixture into exactly
32,000 PCM bytes. End-to-end worker times, including loading the core, were
413 ms (DTS), 442 ms (TrueHD), 313 ms (AAC), 304 ms (AC3), and 245 ms (EAC3).
Measured output was 439–440 Hz with RMS approximately 0.062. These short
synthetic checks establish device functionality, not sustained movie playback
performance or the accuracy of future speech/subtitle alignment.
