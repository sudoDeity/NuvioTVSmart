export const FRAME_MS = 32;
const MAX_FRAMES = (6 * 3600000) / FRAME_MS;
export class SpeechTimeline {
  constructor() {
    this.values = new Uint8Array(MAX_FRAMES);
    this.known = 0;
    this.end = 0;
    this.version = 0;
  }
  record(frame, probability) {
    if (
      !Number.isInteger(frame) ||
      frame < 0 ||
      frame >= MAX_FRAMES ||
      !Number.isFinite(probability)
    )
      return;
    if (!this.values[frame]) this.known++;
    this.values[frame] = 1 + Math.round(Math.sqrt(Math.max(0, Math.min(1, probability))) * 254);
    this.end = Math.max(this.end, frame + 1);
    this.version++;
  }
  segments({ fromFrame = 0, toFrame = this.end, maxFrames = 37500 } = {}) {
    const out = [];
    let kept = 0;
    // Most recent known frames; holes are excluded, never silently interpreted as silence.
    for (let end = Math.min(this.end, toFrame); end > fromFrame && kept < maxFrames;) {
      while (end > fromFrame && !this.values[end - 1]) end--;
      if (end <= fromFrame) break;
      let start = end - 1;
      while (start > fromFrame && this.values[start - 1] && end - start < maxFrames - kept) start--;
      const probabilities = new Float64Array(end - start);
      for (let i = start; i < end; i++)
        probabilities[i - start] = ((this.values[i] - 1) / 254) ** 2;
      out.unshift({ fromFrame: start, probabilities });
      kept += end - start;
      end = start;
    }
    return out;
  }
  clear() {
    this.values.fill(0);
    this.known = 0;
    this.end = 0;
    this.version++;
  }
}

export function dialogueCues(cues) {
  if (!Array.isArray(cues) || cues.length > 6000) return [];
  return cues
    .filter(
      (c) =>
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end > c.start &&
        c.end - c.start < 20 &&
        c.end <= 6 * 3600 &&
        isDialogue(c.text)
    )
    .map((c) => ({ start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
export function isDialogue(text) {
  if (!String(text || "").trim()) return true;
  return String(text)
    .replace(/<[^>]*>|\{[^}]*\}|\[[^\]]*\]|\([^)]*\)/g, "")
    .split(/\r?\n/)
    .some((line) => !/^\s*[♪♫#]/.test(line) && /[\w\u00c0-\uffff]/.test(line));
}
export function renderDialogue(cues, fromFrame, length, scale) {
  const out = new Float64Array(length);
  for (const cue of cues) {
    const a = Math.max(0, (cue.start * 1000 * scale) / FRAME_MS - fromFrame);
    const b = Math.min(length, (cue.end * 1000 * scale) / FRAME_MS - fromFrame);
    if (b <= a) continue;
    for (let i = Math.floor(a); i < Math.ceil(b); i++)
      out[i] = Math.min(1, out[i] + Math.min(b, i + 1) - Math.max(a, i));
  }
  return out;
}
