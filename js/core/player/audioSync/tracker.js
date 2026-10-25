import { estimateSpeech, isLockable, DETECTOR_BIAS_MS } from "./aligner.js";
import { FRAME_MS, renderDialogue } from "./timeline.js";

export function mediaTime(subtitleMs, segments) {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i],
      mapped = subtitleMs * s.scale + s.shiftMs;
    if (
      mapped >= (i ? s.fromMediaMs : -Infinity) &&
      mapped < (segments[i + 1] ? segments[i + 1].fromMediaMs : Infinity)
    )
      return mapped;
  }
  return null;
}
export function retimeAudioCues(cues, mapping) {
  const segments = mapping && mapping.segments;
  if (
    !Array.isArray(segments) ||
    !segments.length ||
    segments.length > 64 ||
    segments.some(
      (s, i) =>
        !Number.isFinite(s.scale) ||
        s.scale < 0.94 ||
        s.scale > 1.06 ||
        !Number.isFinite(s.shiftMs) ||
        Math.abs(s.shiftMs) > 180000 ||
        !Number.isFinite(s.fromMediaMs) ||
        s.fromMediaMs < 0 ||
        (i && s.fromMediaMs <= segments[i - 1].fromMediaMs)
    )
  )
    return null;
  return cues
    .map((c) => {
      const start = mediaTime(c.start * 1000, segments),
        end = mediaTime(c.end * 1000, segments);
      return start == null || end == null || end <= start
        ? null
        : { ...c, start: Math.max(0, start / 1000), end: Math.max(0, end / 1000) };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
export function segmentAt(mapping, positionMs) {
  return mapping.segments.reduce(
    (s, next) => (next.fromMediaMs <= positionMs ? next : s),
    mapping.segments[0]
  );
}
function changePoint(timeline, cues, from, to, old, next, bias) {
  const evidence = timeline.segments({ fromFrame: from, toFrame: to });
  let sum = 0,
    count = 0;
  for (const s of evidence)
    for (const p of s.probabilities) {
      sum += p;
      count++;
    }
  if (!count) return null;
  let suffix = 0,
    best = 0,
    result = null;
  const oldTrack = renderDialogue(
    cues,
    from - Math.round((old.shiftMs + bias) / FRAME_MS),
    to - from,
    old.scale
  );
  const newTrack = renderDialogue(
    cues,
    from - Math.round((next.shiftMs + bias) / FRAME_MS),
    to - from,
    next.scale
  );
  for (let j = evidence.length - 1; j >= 0; j--) {
    const s = evidence[j];
    for (let i = s.probabilities.length - 1; i >= 0; i--) {
      const frame = s.fromFrame + i;
      suffix +=
        (s.probabilities[i] - sum / count) * (newTrack[frame - from] - oldTrack[frame - from]);
      if (suffix > best) {
        best = suffix;
        result = frame * FRAME_MS;
      }
    }
  }
  return result;
}
export class AudioSyncTracker {
  constructor(cues, { detectorBiasMs = DETECTOR_BIAS_MS } = {}) {
    this.cues = cues;
    this.options = { detectorBiasMs };
    this.mapping = null;
    this.version = -1;
    this.pending = null;
    this.provisional = null;
  }
  update(timeline, playbackMs) {
    if (timeline.version === this.version)
      return { status: this.mapping ? "locked" : "searching", mapping: null };
    this.version = timeline.version;
    const evidence = timeline.segments();
    const knownSeconds =
      (evidence.reduce((n, s) => n + s.probabilities.length, 0) * FRAME_MS) / 1000;
    if (knownSeconds < 30) return { status: "collecting", mapping: null };
    if (!this.mapping) {
      let estimate = estimateSpeech(evidence, this.cues, this.options);
      let accepted = isLockable(estimate, evidence, this.cues, this.options);
      // Samples from a later edited scene must not permanently prevent a
      // locally consistent opening from locking. The same confidence checks apply.
      if (!accepted) {
        const local = timeline.segments({
          fromFrame: Math.max(0, Math.floor((playbackMs - 120000) / FRAME_MS)),
          toFrame: Math.ceil((playbackMs + 30000) / FRAME_MS)
        });
        const candidate =
          local.reduce((n, s) => n + s.probabilities.length, 0) * FRAME_MS >= 60000
            ? estimateSpeech(local, this.cues, this.options)
            : null;
        if (isLockable(candidate, local, this.cues, this.options)) {
          estimate = candidate;
          accepted = true;
        }
      }
      if (accepted) {
        this.mapping = {
          segments: [{ fromMediaMs: 0, scale: estimate.scale, shiftMs: estimate.shiftMs }],
          confirmed: true
        };
        this.provisional = null;
        this.pending = null;
        return { status: "locked", mapping: this.mapping, estimate };
      }
      // A preview is reversible and never persisted as a confirmed match.
      if (
        estimate &&
        estimate.scale === 1 &&
        !estimate.atSearchEdge &&
        estimate.cueCount >= 12 &&
        estimate.speechSeconds >= 8 &&
        estimate.prominence >= 0.2
      ) {
        this.pending =
          this.pending && Math.abs(this.pending.shiftMs - estimate.shiftMs) < 250
            ? { ...estimate, repeats: this.pending.repeats + 1 }
            : { ...estimate, repeats: 1 };
        if (this.pending.repeats >= 3) {
          this.provisional = {
            segments: [{ fromMediaMs: 0, scale: 1, shiftMs: estimate.shiftMs }],
            confirmed: false
          };
          return { status: "provisional", mapping: this.provisional, estimate };
        }
      } else {
        this.pending = null;
        if (this.provisional) {
          this.provisional = null;
          return { status: "retracted", mapping: null, estimate };
        }
      }
      return { status: "searching", mapping: null, estimate };
    }
    const old = segmentAt(this.mapping, playbackMs);
    const to = Math.floor(playbackMs / FRAME_MS),
      from = Math.max(Math.floor(old.fromMediaMs / FRAME_MS), to - Math.ceil(120000 / FRAME_MS));
    const local = timeline.segments({ fromFrame: from, toFrame: to });
    const estimate = estimateSpeech(local, this.cues, this.options);
    if (!isLockable(estimate, local, this.cues, this.options))
      return { status: "locked", mapping: null, estimate };
    const delta =
      (estimate.scale - old.scale) * ((playbackMs - old.shiftMs) / old.scale) +
      estimate.shiftMs -
      old.shiftMs;
    if (Math.abs(delta) < 40) return { status: "locked", mapping: null, estimate };
    if (Math.abs(delta) > 1000) {
      this.pending =
        this.pending &&
        Math.abs(this.pending.shiftMs - estimate.shiftMs) < 250 &&
        this.pending.scale === estimate.scale
          ? { ...estimate, repeats: this.pending.repeats + 1 }
          : { ...estimate, repeats: 1 };
      if (this.pending.repeats < 2 || this.mapping.segments.length >= 64)
        return { status: "locked", mapping: null, estimate };
      const point = changePoint(
        timeline,
        this.cues,
        Math.max(Math.floor(old.fromMediaMs / FRAME_MS), to - Math.ceil((20 * 60000) / FRAME_MS)),
        to,
        old,
        estimate,
        this.options.detectorBiasMs
      );
      if (point == null || point < old.fromMediaMs + 30000)
        return { status: "locked", mapping: null, estimate };
      this.mapping = {
        confirmed: true,
        segments: this.mapping.segments
          .filter((s) => s.fromMediaMs < point)
          .concat({ fromMediaMs: point, scale: estimate.scale, shiftMs: estimate.shiftMs })
      };
    } else {
      // Refinements preserve the boundaries of previously confirmed edits.
      this.mapping = {
        confirmed: true,
        segments: this.mapping.segments.map((s) =>
          s === old ? { ...s, scale: estimate.scale, shiftMs: estimate.shiftMs } : s
        )
      };
    }
    this.pending = null;
    return { status: "refined", mapping: this.mapping, estimate };
  }
}
