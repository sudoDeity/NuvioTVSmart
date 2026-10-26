The compatible playback module decodes DTS or TrueHD and encodes AC3 inside a dedicated browser Worker. Video never enters FFmpeg. There are no native binaries, threads, SIMD, BigInt integration, or external servers. The WASM module validates against the WebAssembly MVP and has a fixed 32 MiB memory; the service limits source clusters to 8 MiB and retained media buffers to 24 MiB. A CPU budget stops decoding that needs more than 65% of the audio's elapsed time (after the first two seconds). Failed streams retain the original selected audio track without repeated attempts.

The implementation supports seekable Matroska with video Cues, SimpleBlock DTS or TrueHD frames, uncompressed/unencrypted track metadata, 48 kHz audio and at most eight source channels. Mono, stereo and standard layouts up to 5.1 retain their channel count. Six- and seven-point-one sources request the source decoder's 5.1(side) downmix and are encoded as six-channel AC3; rematrixing uses a maximum value of 1 to avoid clipping. The projected Matroska header declares six output channels without changing element sizes or seek offsets. Unsupported formats, insufficient padding space, discontinuities, memory limits, decode errors or insufficient performance stop conversion. Compatibility with older webOS models is conditional on their actual performance and native AC3/MKV playback; only the LG G5 has been tested physically.

`ffmpeg-core.js` and `ffmpeg-core.wasm` are built from FFmpeg 5.1.4 (LGPL 2.1 or later) and the MIT licensed ffmpeg.wasm bindings. Copies of both licenses accompany the binaries. Complete corresponding upstream sources are pinned to:

- https://github.com/FFmpeg/FFmpeg/tree/4729204c17f756e186d622060088371d10b34f7e
- https://github.com/ffmpegwasm/ffmpeg.wasm/tree/f876f907c7e9b9bf51d4ed0b913a855a63ae63fc

All build flags and the legacy CLI timeout patch are in `scripts/build-webos-dts.sh`. The optimized analysis wrapper is provided as source in `services/shared/audio-sync/decoder/sample-decoder.c`. Activate Emscripten 3.1.40, then run that script to rebuild/relink the module. The C patch changes the millisecond timeout argument to 32 bits to avoid requiring WebAssembly BigInt integration. Binaryen lowers sign-extension instructions and strips target feature metadata. The production app uses the provided prebuilt files; a normal app build does not download a compiler or source code.

TrueHD is restricted to 48 kHz access units (40 samples), with at most 16,384 packets per source cue range. Consecutive selected audio blocks share a bounded output slot, leaving every other element at its original byte offset. Small slots defer AC3 frames to the next slot within the same cue range; insufficient total space stops conversion rather than dropping audio. Each seek generation starts at its first TrueHD major sync and anchors output to that packet timestamp; subsequent ranges retain the continuous decoder. Atmos metadata is not retained. The real LG G5 sample decoded 7.1 seconds in about 1.35 seconds at 32 MiB WASM memory; this is a sample measurement, not a guarantee for other files or TV models.

DTS and TrueHD use the same selection, encoder, playback session, seek generations, memory/CPU budgets and failure policy. Both require every expected AC3 frame to fit before a converted range is served. Only source packet parsing, TrueHD major-sync alignment and small-block grouping differ by codec.


## Audio sample decoder: SIMD and compatible fallback

`sample-worker.js` serves bounded audio analysis on webOS and Tizen. It returns
16 kHz mono signed 16-bit little-endian PCM from AAC/ADTS, AC3, EAC3, DTS core
and TrueHD packets. The caller supplies independently decodable packets and
retains their track and media timestamps. No video enters either decoder.

The worker validates a small standard WASM SIMD module at runtime. Supported
engines use `simd/ffmpeg-core.js` and `.wasm`, a dedicated audio decoder built
with `-O3`, SIMD and link-time optimization. Floating-point reassociation and
`-ffast-math` are not enabled; numerical checks retain their normal semantics.
This module links FFmpeg's codec, parser, resampler and utility libraries directly,
without the FFmpeg CLI, demuxers, filter graph, encoders or a virtual filesystem.
The entire wrapper source and exact flags are included in this repository.

Older engines use the existing MVP `ffmpeg-core.js` and `.wasm`. Loading,
compilation or optimized decode failures retry the original compressed input
once through that compatible core. A fatal worker failure or wall-clock timeout
triggers one fresh worker using the compatible path. Cancelled requests do not
retry. Successful fallback selection is remembered for the current app/service
base. The playback `worker.js` continues to use its existing compatible core.

Both variants have a fixed 32 MiB WASM heap, a 4 MiB compressed input cap, an
8-second execution budget and at most 30 seconds / 960,000 bytes of output.
The direct module uses fixed input/output areas and releases codec/parser/resampler
state after each window. It rejects source format/rate/layout changes within a
window. It transfers only actual decoded samples, including resampler drainage;
it never pads missing audio into speech evidence.

Codec-level stereo downmix reduces synthesis/rematrix work for AC3, EAC3 and DTS.
DTS uses its core-only mode. TrueHD requests the 5.1 presentation: stereo
substreams can omit the center channel. AAC retains its decoder layout. Final
mono rematrixing uses `rematrix_maxval=1` in both paths. These are analysis
presentations; no changes are applied to movie playback or its selected audio.

`js/platform/audioSampleDecoder.js` owns one shared decoder worker. Successful
requests keep the compiled core warm for the next window, including across
codec changes. Samples and their promise handlers are released after completion.
An abort, analysis-session stop, stream/track change, failure or 30 seconds of
idle time terminates the worker. Replies carry request IDs and worker identity
checks prevent a late failed-worker result from committing over its replacement.
The per-attempt wall-clock deadline is 12 seconds, with at most one fresh-worker
fallback. The source-sampling request additionally retains its overall 45-second
network/decode deadline.

`decodeWebOsAudioSample({ input, format, durationSeconds, signal })` locates the
local companion service, preserves the caller's packets and uses the same pool.
The automatic sync repository also shares it on Tizen. PCM output uses the
existing caller-facing shape (`pcm`, `sampleRate`, `channels`, `sampleFormat`,
`durationSeconds`), with `variant` identifying `simd` or `legacy`.

### Rebuild and verification

Activate Emscripten 3.1.40, then run:

```sh
bash scripts/build-webos-dts.sh --simd   # Direct SIMD audio-analysis module
bash scripts/build-webos-dts.sh --legacy # Compatible analysis/playback module
bash scripts/build-webos-dts.sh --all    # Both (the default)
npm run test:audio-sample
```

`NUVIO_DTS_OUTPUT` overrides the base output directory. SIMD files go under its
`simd/` child. `WASM_OPT` can override Binaryen's executable; otherwise the script
finds it alongside the active SDK. `NUVIO_DTS_KEEP_BUILD=1` retains an intermediate
build for investigation and prints its path. Production app builds use checked-in
artifacts and do not download compilers or sources. Both artifact pairs must be
kept together. The license files accompany each pair.

Tests decode all five formats with each real WASM module, verify multichannel
center-channel bursts and silence (including 5.1 and 7.1 TrueHD), compare PCM,
exercise 40 sequential mixed-codec windows, force load/decode/worker failures and
verify the compatible retry, cancellation, idle cleanup, stale replies and input
preservation. Existing DTS/TrueHD-to-AC3 playback checks still use the MVP core.
Device performance measurements use synthetic multichannel fixtures on the G4;
real-film network access and concurrent 4K/HDR playback remain separate checks.
