// Port of the speech-activity path in NuvioTV PR #4150 (GPL-3.0).
// Map: media milliseconds = subtitle milliseconds * scale + shiftMs.
import { fft, fftSize } from "./fft.js";
import { FRAME_MS, renderDialogue } from "./timeline.js";
export const SCALES = [1, 24000 / 23976, 23976 / 24000, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25];
// This is a configurable detector calibration, not a universal V5/V6 latency guarantee.
export const DETECTOR_BIAS_MS = 100;

export function prepareSpeech(
  segments,
  { minShiftMs = -60000, maxShiftMs = 60000, detectorBiasMs = DETECTOR_BIAS_MS } = {}
) {
  const count = segments.reduce((sum, s) => sum + s.probabilities.length, 0);
  if (count < 2) return null;
  let sum = 0;
  for (const s of segments)
    for (const p of s.probabilities) {
      if (!Number.isFinite(p)) throw Error("Unknown audio must be split into segments");
      sum += p;
    }
  const mean = sum / count,
    minLag = Math.floor((minShiftMs + detectorBiasMs) / FRAME_MS);
  const maxLag = Math.floor((maxShiftMs + detectorBiasMs) / FRAME_MS) + 1,
    lagCount = maxLag - minLag + 1;
  let energy = 0;
  const parts = segments.map((s) => {
    const n = s.probabilities.length,
      gLength = n + lagCount - 1,
      size = fftSize(n + gLength);
    const re = new Float64Array(size),
      im = new Float64Array(size);
    for (let i = 0; i < n; i++) {
      re[i] = s.probabilities[i] - mean;
      energy += re[i] ** 2;
    }
    fft(re, im);
    return { fromFrame: s.fromFrame, n, gLength, re, im, size };
  });
  if (energy <= 1e-9) return null;
  return {
    estimate(cues, scales = SCALES) {
      let best = null,
        unit = null;
      for (const scale of scales) {
        const cross = new Float64Array(lagCount),
          cm = new Float64Array(lagCount),
          cm2 = new Float64Array(lagCount);
        for (const part of parts) {
          const g = renderDialogue(cues, part.fromFrame - maxLag, part.gLength, scale);
          const re = new Float64Array(part.size),
            im = new Float64Array(part.size);
          re.set(g);
          fft(re, im);
          for (let i = 0; i < part.size; i++) {
            const r = part.re[i] * re[i] + part.im[i] * im[i];
            im[i] = part.re[i] * im[i] - part.im[i] * re[i];
            re[i] = r;
          }
          fft(re, im, true);
          let total = 0,
            squares = 0;
          for (let i = 0; i < part.n; i++) {
            total += g[i];
            squares += g[i] ** 2;
          }
          for (let k = 0; k < lagCount; k++) {
            cross[k] += re[k];
            cm[k] += total;
            cm2[k] += squares;
            if (k + 1 < lagCount) {
              total += g[k + part.n] - g[k];
              squares += g[k + part.n] ** 2 - g[k] ** 2;
            }
          }
        }
        const scores = new Float64Array(lagCount);
        let peakIndex = -1;
        for (let k = 0; k < lagCount; k++) {
          const variance = cm2[k] - cm[k] ** 2 / count;
          scores[k] =
            variance > 1e-6 * count && cm[k] > 0.5 ? cross[k] / Math.sqrt(energy * variance) : NaN;
          if (Number.isFinite(scores[k]) && (peakIndex < 0 || scores[k] > scores[peakIndex]))
            peakIndex = k;
        }
        if (peakIndex < 0) continue;
        const peak = scores[peakIndex];
        let runnerUp = -Infinity,
          refined = peakIndex;
        for (let k = 0; k < lagCount; k++)
          if (Math.abs(k - peakIndex) > Math.floor(2500 / FRAME_MS) && Number.isFinite(scores[k]))
            runnerUp = Math.max(runnerUp, scores[k]);
        if (peakIndex > 0 && peakIndex < lagCount - 1) {
          const left = scores[peakIndex - 1],
            right = scores[peakIndex + 1],
            curvature = left - 2 * peak + right;
          if (Number.isFinite(left) && Number.isFinite(right) && curvature < 0)
            refined += Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature));
        }
        const shiftMs = (maxLag - refined) * FRAME_MS - detectorBiasMs;
        let cueCount = 0;
        for (const part of parts)
          cueCount += cues.filter(
            (c) =>
              c.end * 1000 * scale + shiftMs > part.fromFrame * FRAME_MS &&
              c.start * 1000 * scale + shiftMs < (part.fromFrame + part.n) * FRAME_MS
          ).length;
        const result = {
          scale,
          shiftMs,
          peak,
          prominence: peak - (Number.isFinite(runnerUp) ? runnerUp : 0),
          analysedSeconds: (count * FRAME_MS) / 1000,
          speechSeconds: (sum * FRAME_MS) / 1000,
          cueCount,
          atSearchEdge: peakIndex < 1500 / FRAME_MS || peakIndex >= lagCount - 1500 / FRAME_MS
        };
        if (scale === 1) unit = result;
        if (!best || result.peak > best.peak) best = result;
      }
      if (unit && best && Math.abs(best.scale - 1) < 0.002 && unit.peak >= best.peak - 0.01)
        return unit;
      return best;
    }
  };
}
export function estimateSpeech(segments, cues, options = {}) {
  const prepared = prepareSpeech(segments, options);
  return prepared ? prepared.estimate(cues, options.scales || SCALES) : null;
}
export function splitEvidence(segments) {
  let remaining = Math.floor(segments.reduce((n, s) => n + s.probabilities.length, 0) / 2);
  const left = [],
    right = [];
  for (const s of segments) {
    const take = Math.min(remaining, s.probabilities.length);
    if (take) left.push({ fromFrame: s.fromFrame, probabilities: s.probabilities.slice(0, take) });
    if (take < s.probabilities.length)
      right.push({ fromFrame: s.fromFrame + take, probabilities: s.probabilities.slice(take) });
    remaining -= take;
  }
  return [left, right];
}
export function isLockable(estimate, segments, cues, options = {}) {
  if (
    !estimate ||
    estimate.analysedSeconds < 60 ||
    estimate.cueCount < 20 ||
    estimate.speechSeconds < 12 ||
    estimate.atSearchEdge ||
    estimate.prominence < 0.12 + (Math.abs(estimate.scale - 1) >= 0.002 ? 0.04 : 0)
  )
    return false;
  return splitEvidence(segments).every((half) => {
    const e = estimateSpeech(half, cues, { ...options, scales: [estimate.scale] });
    return e && !e.atSearchEdge && e.cueCount >= 8 && Math.abs(e.shiftMs - estimate.shiftMs) <= 400;
  });
}
