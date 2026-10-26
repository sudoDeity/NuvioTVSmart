#!/usr/bin/env bash
# Rebuild the LGPL playback/sample modules. Activate Emscripten 3.1.40 first.
set -euo pipefail
emcc --version | head -1 | grep -q '3.1.40' || { echo 'Emscripten 3.1.40 is required'; exit 1; }
DTS_WASM_OPT="${WASM_OPT:-$(command -v wasm-opt || true)}"
if [ -z "$DTS_WASM_OPT" ]; then
  DTS_WASM_OPT="$(dirname "$(command -v emcc)")/../bin/wasm-opt"
fi
[ -x "$DTS_WASM_OPT" ] || { echo 'wasm-opt from the active Emscripten SDK is required'; exit 1; }
DTS_VARIANT="${1:---all}"
case "$DTS_VARIANT" in
  --all) bash "$0" --legacy; bash "$0" --simd; exit ;;
  --legacy|--simd) ;;
  *) echo 'Usage: build-webos-dts.sh [--all|--legacy|--simd]'; exit 1 ;;
esac
DTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DTS_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nuvio-dts-build.XXXXXX")"
if [ "${NUVIO_DTS_KEEP_BUILD:-0}" = 1 ]; then
  trap 'echo "Retained build: $DTS_BUILD_ROOT"' EXIT
else
  trap 'rm -rf "$DTS_BUILD_ROOT"' EXIT
fi
mkdir -p "$DTS_BUILD_ROOT/ffmpeg" "$DTS_BUILD_ROOT/bindings"
curl -fsSL https://github.com/FFmpeg/FFmpeg/archive/4729204c17f756e186d622060088371d10b34f7e.tar.gz -o "$DTS_BUILD_ROOT/ffmpeg.tar.gz"
curl -fsSL https://github.com/ffmpegwasm/ffmpeg.wasm/archive/f876f907c7e9b9bf51d4ed0b913a855a63ae63fc.tar.gz -o "$DTS_BUILD_ROOT/bindings.tar.gz"
tar -xzf "$DTS_BUILD_ROOT/ffmpeg.tar.gz" --strip-components=1 -C "$DTS_BUILD_ROOT/ffmpeg"
tar -xzf "$DTS_BUILD_ROOT/bindings.tar.gz" --strip-components=1 -C "$DTS_BUILD_ROOT/bindings"
cp -R "$DTS_BUILD_ROOT/bindings/src/bind" "$DTS_BUILD_ROOT/ffmpeg/bind"
cp "$DTS_BUILD_ROOT/bindings/src/fftools/"* "$DTS_BUILD_ROOT/ffmpeg/fftools/"
python3 - "$DTS_BUILD_ROOT/ffmpeg/fftools/ffmpeg.c" <<'PY'
import sys
p=sys.argv[1]
s=open(p).read().replace('EM_JS(int, is_timeout, (int64_t diff)', 'EM_JS(int, is_timeout, (int32_t diff)')
open(p,'w').write(s)
PY
cd "$DTS_BUILD_ROOT/ffmpeg"
DTS_OUTPUT="${NUVIO_DTS_OUTPUT:-$DTS_REPO_ROOT/services/webos/runtime/dts}"
DTS_OPT_FLAGS='-O3'
DTS_CHROME=68
DTS_SIZE_FLAGS=(--enable-small)
if [ "$DTS_VARIANT" = --simd ]; then
  DTS_OUTPUT="$DTS_OUTPUT/simd"
  DTS_OPT_FLAGS='-O3 -flto -msimd128'
  DTS_CHROME=91
  DTS_SIZE_FLAGS=(--disable-small --disable-avformat --disable-avfilter --disable-encoders)
fi
export EMCC_CFLAGS="$DTS_OPT_FLAGS -sMIN_CHROME_VERSION=$DTS_CHROME -sWASM_BIGINT=0"
emconfigure ./configure --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm --disable-x86asm --disable-stripping --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect --disable-autodetect --disable-pthreads --disable-w32threads --disable-os2threads --disable-everything --disable-network --disable-avdevice --disable-postproc --disable-swscale --disable-iconv --disable-zlib --disable-bzlib --enable-decoder=dca,truehd,aac,ac3,eac3 --enable-encoder=ac3,pcm_s16le --enable-parser=dca,mlp,aac,ac3 --enable-demuxer=dts,truehd,aac,ac3,eac3 --enable-muxer=ac3,pcm_s16le --enable-protocol=file --enable-filter=anull,aformat,aresample,atrim "${DTS_SIZE_FLAGS[@]}" --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --extra-cflags="$DTS_OPT_FLAGS" --extra-cxxflags="$DTS_OPT_FLAGS"
emmake make -j6
mkdir -p "$DTS_OUTPUT"
# Word splitting of DTS_OPT_FLAGS deliberately supplies separate compiler flags.
# The optimized analysis module links only libavcodec/libswresample/libavutil.
if [ "$DTS_VARIANT" = --simd ]; then
  emcc $DTS_OPT_FLAGS -I. -Ilibavutil -Llibavcodec -Llibavutil -Llibswresample \
    "$DTS_REPO_ROOT/services/shared/audio-sync/decoder/sample-decoder.c" \
    -lavcodec -lswresample -lavutil -sFILESYSTEM=0 -sENVIRONMENT=worker -sWASM_BIGINT=0 \
    -sMIN_CHROME_VERSION=91 -sSTACK_SIZE=2MB -sINITIAL_MEMORY=32MB -sALLOW_MEMORY_GROWTH=0 \
    -sMODULARIZE -sEXPORT_NAME=createAudioDecoder \
    '-sEXPORTED_FUNCTIONS=_sample_input,_sample_output,_sample_decode' \
    -o "$DTS_OUTPUT/ffmpeg-core.js"
else
  emcc $DTS_OPT_FLAGS -I. -Ifftools -Llibavcodec -Llibavfilter -Llibavformat -Llibavutil -Llibswresample -lavcodec -lavfilter -lavformat -lavutil -lswresample -Wno-deprecated-declarations -sENVIRONMENT=worker -sWASM_BIGINT=0 -sMIN_CHROME_VERSION="$DTS_CHROME" -sSTACK_SIZE=2MB -sINITIAL_MEMORY=32MB -sALLOW_MEMORY_GROWTH=0 -sMODULARIZE -sEXPORT_NAME=createFFmpegCore '-sEXPORTED_FUNCTIONS=_ffmpeg,_abort,_malloc,_ffprobe' '-sEXPORTED_RUNTIME_METHODS=FS,setValue,getValue,UTF8ToString,lengthBytesUTF8,stringToUTF8' --pre-js bind/ffmpeg/bind.js fftools/cmdutils.c fftools/ffmpeg.c fftools/ffmpeg_filter.c fftools/ffmpeg_hw.c fftools/ffmpeg_mux.c fftools/ffmpeg_opt.c fftools/opt_common.c fftools/ffprobe.c -o "$DTS_OUTPUT/ffmpeg-core.js"
fi
if [ "$DTS_VARIANT" = --simd ]; then
  "$DTS_WASM_OPT" "$DTS_OUTPUT/ffmpeg-core.wasm" -O3 --enable-simd --strip-debug --strip-target-features -o "$DTS_BUILD_ROOT/optimized.wasm"
  cp "$DTS_BUILD_ROOT/optimized.wasm" "$DTS_OUTPUT/ffmpeg-core.wasm"
else
  "$DTS_WASM_OPT" "$DTS_OUTPUT/ffmpeg-core.wasm" --signext-lowering --mvp-features --strip-target-features -o "$DTS_BUILD_ROOT/lowered.wasm"
  "$DTS_WASM_OPT" "$DTS_BUILD_ROOT/lowered.wasm" --mvp-features -o "$DTS_OUTPUT/ffmpeg-core.wasm"
fi
cp COPYING.LGPLv2.1 "$DTS_OUTPUT/COPYING.LGPLv2.1"
cp "$DTS_BUILD_ROOT/bindings/LICENSE" "$DTS_OUTPUT/ffmpeg-wasm.LICENSE"
