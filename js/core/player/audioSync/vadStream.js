import { FRAME_MS, SpeechTimeline } from "./timeline.js";
export class VadStream {
  constructor(vad) {
    this.vad = vad;
    this.timeline = new SpeechTimeline();
  }
  ingest(pcm, startMs) {
    if (
      !(pcm instanceof ArrayBuffer) ||
      !pcm.byteLength ||
      pcm.byteLength % 2 ||
      pcm.byteLength > 960000 ||
      !Number.isFinite(startMs) ||
      startMs < -2000 ||
      startMs > 6 * 3600000
    )
      throw Error("Invalid PCM window");
    const samples = new DataView(pcm),
      chunk = new Float32Array(512);
    let frame = Math.ceil(Math.max(0, startMs) / FRAME_MS);
    let offset = Math.round((frame * FRAME_MS - startMs) * 16);
    this.vad.reset();
    let warmup = 4;
    for (; offset + 512 <= pcm.byteLength / 2; offset += 512, frame++) {
      for (let i = 0; i < 512; i++) chunk[i] = samples.getInt16((offset + i) * 2, true) / 32768;
      const p = this.vad.process_chunk(chunk);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw Error("Invalid VAD output");
      if (warmup) warmup--;
      else this.timeline.record(frame, p);
    }
    return this.timeline;
  }
  free() {
    this.vad.free();
    this.timeline.clear();
  }
}
