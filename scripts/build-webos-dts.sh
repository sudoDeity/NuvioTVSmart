#!/usr/bin/env bash
# Rebuild the LGPL playback/sample audio module. Activate Emscripten 3.1.40 first.
set -euo pipefail
emcc --version | head -1 | grep -q '3.1.40' || { echo 'Emscripten 3.1.40 is required'; exit 1; }
DTS_REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DTS_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/nuvio-dts-build.XXXXXX")"
trap 'rm -rf "$DTS_BUILD_ROOT"' EXIT
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
export EMCC_CFLAGS='-O3 -sMIN_CHROME_VERSION=68 -sWASM_BIGINT=0'
emconfigure ./configure --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm --disable-x86asm --disable-stripping --disable-programs --disable-doc --disable-debug --disable-runtime-cpudetect --disable-autodetect --disable-pthreads --disable-w32threads --disable-os2threads --disable-everything --disable-network --disable-avdevice --disable-postproc --disable-swscale --disable-iconv --disable-zlib --disable-bzlib --enable-decoder=dca,truehd,aac,ac3,eac3 --enable-encoder=ac3,pcm_s16le --enable-parser=dca,mlp,aac,ac3 --enable-demuxer=dts,truehd,aac,ac3,eac3 --enable-muxer=ac3,pcm_s16le --enable-protocol=file --enable-filter=anull,aformat,aresample,atrim --enable-small --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --extra-cflags='-O3' --extra-cxxflags='-O3'
emmake make -j6
DTS_OUTPUT="${NUVIO_DTS_OUTPUT:-$DTS_REPO_ROOT/services/webos/runtime/dts}"
mkdir -p "$DTS_OUTPUT"
emcc -O3 -I. -Ifftools -Llibavcodec -Llibavfilter -Llibavformat -Llibavutil -Llibswresample -lavcodec -lavfilter -lavformat -lavutil -lswresample -Wno-deprecated-declarations -sENVIRONMENT=worker -sWASM_BIGINT=0 -sMIN_CHROME_VERSION=68 -sSTACK_SIZE=2MB -sINITIAL_MEMORY=32MB -sALLOW_MEMORY_GROWTH=0 -sMODULARIZE -sEXPORT_NAME=createFFmpegCore '-sEXPORTED_FUNCTIONS=_ffmpeg,_abort,_malloc,_ffprobe' '-sEXPORTED_RUNTIME_METHODS=FS,setValue,getValue,UTF8ToString,lengthBytesUTF8,stringToUTF8' --pre-js bind/ffmpeg/bind.js fftools/cmdutils.c fftools/ffmpeg.c fftools/ffmpeg_filter.c fftools/ffmpeg_hw.c fftools/ffmpeg_mux.c fftools/ffmpeg_opt.c fftools/opt_common.c fftools/ffprobe.c -o "$DTS_OUTPUT/ffmpeg-core.js"
wasm-opt "$DTS_OUTPUT/ffmpeg-core.wasm" --signext-lowering --mvp-features --strip-target-features -o "$DTS_BUILD_ROOT/lowered.wasm"
wasm-opt "$DTS_BUILD_ROOT/lowered.wasm" --mvp-features -o "$DTS_OUTPUT/ffmpeg-core.wasm"
cp COPYING.LGPLv2.1 "$DTS_OUTPUT/COPYING.LGPLv2.1"
cp "$DTS_BUILD_ROOT/bindings/LICENSE" "$DTS_OUTPUT/ffmpeg-wasm.LICENSE"
