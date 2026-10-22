// Timing-only, bounded affine alignment. Seconds throughout; no text leaves the player.
// Kept independent of TV APIs so the worker and regression tests use the same matcher.
const MAX_CUES = 6000;
const MAX_SECONDS = 6 * 3600;
const SCALES = [
  1,
  1000 / 1001,
  1001 / 1000,
  24 / 25,
  25 / 24,
  24000 / 25025,
  25025 / 24000,
  0.94,
  0.96,
  0.98,
  1.02,
  1.04,
  1.06
];

function normalize(cues) {
  if (!Array.isArray(cues) || cues.length < 30 || cues.length > MAX_CUES) return null;
  const sorted = cues
    .map((c) => ({ start: Number(c?.start), end: Number(c?.end) }))
    .filter(
      (c) =>
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end > c.start &&
        c.end <= MAX_SECONDS &&
        c.end - c.start <= 30
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const unique = sorted.filter(
    (c, i) => !i || c.start !== sorted[i - 1].start || c.end !== sorted[i - 1].end
  );
  if (unique.length < 30 || unique.length < cues.length * 0.9) return null;
  if (unique[unique.length - 1].end - unique[0].start < 180) return null;
  return unique;
}

function activity(cues, step, scale = 1, offset = 0) {
  const bins = new Uint8Array(Math.ceil(MAX_SECONDS / step) + 1);
  for (const cue of cues) {
    const start = Math.max(0, Math.round((cue.start * scale + offset) / step));
    const end = Math.min(bins.length, Math.round((cue.end * scale + offset) / step));
    if (end > start) bins.fill(1, start, end);
  }
  return bins;
}

function prefixSum(bins) {
  const prefix = new Uint32Array(bins.length + 1);
  for (let i = 0; i < bins.length; i++) prefix[i + 1] = prefix[i] + bins[i];
  return prefix;
}

function diceAt(target, reference, prefix, start, end, offset) {
  const low = start + offset;
  const high = end + offset;
  if (low < 0 || high >= reference.length) return 0;
  let overlap = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    if (target[i]) {
      count++;
      overlap += reference[i + offset];
    }
  }
  const other = prefix[high] - prefix[low];
  return count >= 12 && other >= 12 ? (2 * overlap) / (count + other) : 0;
}

function bestWindow(target, reference, prefix, center, step, radius, near = 0) {
  const start = Math.max(0, Math.round((center - 45) / step));
  const end = Math.min(target.length - 1, Math.round((center + 45) / step));
  let best = { score: 0, offset: 0 };
  const scores = [];
  for (
    let offset = Math.round((near - radius) / step);
    offset <= Math.round((near + radius) / step);
    offset++
  ) {
    const score = diceAt(target, reference, prefix, start, end, offset);
    scores.push({ score, offset: offset * step });
    if (score > best.score) best = { score, offset: offset * step };
  }
  const competitor = scores.reduce(
    (score, c) => (Math.abs(c.offset - best.offset) > 2.5 ? Math.max(score, c.score) : score),
    0
  );
  return { ...best, margin: best.score - competitor };
}

function nearestStart(cues, value) {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].start < value) low = mid + 1;
    else high = mid;
  }
  return Math.abs((cues[low]?.start ?? Infinity) - value) <
    Math.abs((cues[low - 1]?.start ?? Infinity) - value)
    ? low
    : low - 1;
}

function dialogueCenters(target) {
  const first = target[0].start;
  const span = target[target.length - 1].end - first;
  const bins = activity(target, 0.5);
  return [
    [0.08, 0.3],
    [0.37, 0.63],
    [0.7, 0.92]
  ].map(([low, high]) => {
    let best = { score: -1, center: first + span * ((low + high) / 2) };
    for (let sample = 0; sample <= 8; sample++) {
      const center = first + span * (low + ((high - low) * sample) / 8);
      const start = Math.max(1, Math.round((center - 45) / 0.5));
      const end = Math.min(bins.length, Math.round((center + 45) / 0.5));
      let transitions = 0;
      for (let i = start; i < end; i++) if (bins[i] !== bins[i - 1]) transitions++;
      // Continuous captions and silence provide little evidence about timing.
      if (transitions > best.score) best = { score: transitions, center };
    }
    return best.center;
  });
}

function refineOnsets(target, reference, scale, offset) {
  const pairs = [];
  let previous = -1;
  for (const cue of target) {
    const mapped = cue.start * scale + offset;
    const index = nearestStart(reference, mapped);
    if (index > previous && Math.abs(reference[index].start - mapped) <= 0.45) {
      pairs.push({ x: cue.start, y: reference[index].start });
      previous = index;
    }
  }
  if (pairs.length < target.length * 0.84) return { scale, offset };
  // Trim outliers around the seed before fitting. Onsets are independent of
  // subtitle-specific reading durations; the final validation still checks
  // whole-film activity and coverage in each third.
  const errors = pairs.map((p) => p.y - (p.x * scale + offset)).sort((a, b) => a - b);
  const median = errors[Math.floor(errors.length / 2)];
  const inliers = pairs.filter((p) => Math.abs(p.y - (p.x * scale + offset) - median) <= 0.2);
  if (inliers.length < target.length * 0.84) return { scale, offset };
  const meanX = inliers.reduce((sum, p) => sum + p.x, 0) / inliers.length;
  const meanY = inliers.reduce((sum, p) => sum + p.y, 0) / inliers.length;
  const variance = inliers.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  if (variance <= 0) return { scale, offset };
  const fittedScale = inliers.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0) / variance;
  return { scale: fittedScale, offset: meanY - fittedScale * meanX };
}

function validate(target, reference, scale, offset) {
  if (scale < 0.94 || scale > 1.06 || Math.abs(offset) > 180) return null;
  const transformed = target.map((c) => ({
    start: c.start * scale + offset,
    end: c.end * scale + offset
  }));
  if (transformed[0].start < -0.5 || transformed[transformed.length - 1].end > MAX_SECONDS)
    return null;
  const refBins = activity(reference, 0.1);
  const targetBins = activity(target, 0.1, scale, offset);
  const prefix = prefixSum(refBins);
  const low = Math.max(0, Math.round(transformed[0].start / 0.1));
  const high = Math.round(transformed[transformed.length - 1].end / 0.1);
  const score = diceAt(targetBins, refBins, prefix, low, high, 0);
  if (score < 0.86) return null;
  const segments = [0, 0, 0];
  const totals = [0, 0, 0];
  const residuals = [];
  let skip = 0;
  let longestSkip = 0;
  const onsetSegments = [0, 0, 0];
  const onsetResiduals = [];
  let previousOnsetIndex = -1;
  let onsetSkip = 0;
  let longestOnsetSkip = 0;
  const span = target[target.length - 1].start - target[0].start;
  for (let i = 0; i < target.length; i++) {
    const mapped = transformed[i];
    const segment = Math.min(2, Math.floor((3 * (target[i].start - target[0].start)) / span));
    totals[segment]++;
    const otherIndex = nearestStart(reference, mapped.start);
    const other = reference[otherIndex];
    if (other && otherIndex > previousOnsetIndex && Math.abs(other.start - mapped.start) <= 0.45) {
      onsetResiduals.push(Math.abs(other.start - mapped.start));
      onsetSegments[segment]++;
      previousOnsetIndex = otherIndex;
      onsetSkip = 0;
    } else longestOnsetSkip = Math.max(longestOnsetSkip, ++onsetSkip);
    if (
      other &&
      Math.abs(other.start - mapped.start) <= 0.45 &&
      Math.abs(other.end - mapped.end) <= 0.8
    ) {
      residuals.push(Math.abs(other.start - mapped.start));
      segments[segment]++;
      skip = 0;
    } else longestSkip = Math.max(longestSkip, ++skip);
  }
  const coverage = residuals.length / target.length;
  residuals.sort((a, b) => a - b);
  const durationMatch =
    coverage >= 0.84 &&
    longestSkip <= 8 &&
    totals.every((n, i) => n >= 8 && segments[i] / n >= 0.78) &&
    residuals[Math.floor(residuals.length / 2)] <= 0.2;
  // Different releases can use longer/shorter display durations for the same
  // dialogue. Accept that only with much stronger, unique onset agreement.
  const onsetCoverage = onsetResiduals.length / target.length;
  onsetResiduals.sort((a, b) => a - b);
  const onsetMatch =
    onsetCoverage >= 0.95 &&
    longestOnsetSkip <= 2 &&
    totals.every((n, i) => n >= 8 && onsetSegments[i] / n >= 0.93) &&
    onsetResiduals[Math.floor(onsetResiduals.length / 2)] <= 0.1;
  if (!durationMatch && !onsetMatch) return null;
  return { scale, offset, score, coverage: durationMatch ? coverage : onsetCoverage };
}

function matchReference(target, reference, deadline) {
  const first = target[0].start;
  const span = target[target.length - 1].end - first;
  const adaptive = dialogueCenters(target);
  const regions = [
    [0.12, 0.2, 0.28],
    [0.38, 0.5, 0.62],
    [0.72, 0.8, 0.88]
  ].map((fractions, i) => [...fractions.map((f) => first + span * f), adaptive[i]]);
  const refCoarse = activity(reference, 0.5);
  const refPrefix = prefixSum(refCoarse);
  const refFine = activity(reference, 0.05);
  const finePrefix = prefixSum(refFine);
  const seeds = [];
  for (const scale of SCALES) {
    if (Date.now() > deadline) return null;
    const bins = activity(target, 0.5, scale);
    const windows = regions.map(
      (centers) =>
        centers
          .map((center) => ({
            ...bestWindow(bins, refCoarse, refPrefix, center * scale, 0.5, 180),
            center
          }))
          .filter((w) => w.score >= 0.72 && w.margin >= 0.025)
          .sort((a, b) => b.score + b.margin - (a.score + a.margin))[0]
    );
    if (windows.some((w) => !w)) continue;
    const centers = windows.map((w) => w.center);
    const meanX = centers.reduce((a, b) => a + b, 0) / 3;
    const meanY = windows.reduce((sum, w) => sum + w.offset, 0) / 3;
    const slope =
      centers.reduce((sum, x, i) => sum + (x - meanX) * (windows[i].offset - meanY), 0) /
      centers.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
    const offset = meanY - slope * meanX;
    if (windows.some((w, i) => Math.abs(w.offset - (slope * centers[i] + offset)) > 0.7)) continue;
    seeds.push({
      scale: scale + slope,
      offset,
      centers,
      quality: Math.min(...windows.map((w) => w.score))
    });
  }
  seeds.sort((a, b) => b.quality - a.quality);
  for (const seed of seeds.slice(0, 3)) {
    if (Date.now() > deadline) return null;
    const centers = seed.centers;
    const bins = activity(target, 0.05, seed.scale, seed.offset);
    const corrections = centers.map((c) =>
      bestWindow(bins, refFine, finePrefix, c * seed.scale + seed.offset, 0.05, 0.75)
    );
    if (corrections.some((c) => c.score < 0.82)) continue;
    const meanX = centers.reduce((a, b) => a + b, 0) / 3;
    const meanY = corrections.reduce((sum, w) => sum + w.offset, 0) / 3;
    const slope =
      centers.reduce((sum, x, i) => sum + (x - meanX) * (corrections[i].offset - meanY), 0) /
      centers.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
    if (
      corrections.some(
        (w, i) => Math.abs(w.offset - (slope * centers[i] + meanY - slope * meanX)) > 0.3
      )
    )
      continue;
    const fitted = refineOnsets(
      target,
      reference,
      seed.scale + slope,
      seed.offset + meanY - slope * meanX
    );
    const result = validate(target, reference, fitted.scale, fitted.offset);
    if (result) return result;
  }
  return null;
}

export function matchSubtitleTimelines(cues, tracks, { timeoutMs = 4000 } = {}) {
  const target = normalize(cues);
  if (!target || !Array.isArray(tracks) || tracks.length > 3) return null;
  const deadline = Date.now() + Math.min(4000, Math.max(1, timeoutMs));
  const results = [];
  for (const track of tracks) {
    const reference = normalize(track?.cues);
    if (!reference) continue;
    const result = matchReference(target, reference, deadline);
    if (Date.now() > deadline) return null;
    if (result) results.push({ ...result, trackNumber: track.trackNumber });
  }
  results.sort((a, b) => b.score - a.score);
  if (!results.length) return null;
  const best = results[0];
  // Equally credible, conflicting embedded references are not a basis for changing timing.
  if (
    results.some((r) =>
      [target[0].start, target[target.length - 1].end].some(
        (t) => Math.abs((r.scale - best.scale) * t + r.offset - best.offset) > 0.3
      )
    )
  )
    return null;
  return best;
}

export function retimeSubtitleCues(cues, mapping) {
  if (
    !mapping ||
    !Number.isFinite(mapping.scale) ||
    !Number.isFinite(mapping.offset) ||
    mapping.scale < 0.94 ||
    mapping.scale > 1.06 ||
    Math.abs(mapping.offset) > 180
  )
    return null;
  return cues
    .map((c) => ({
      ...c,
      start: Math.max(0, c.start * mapping.scale + mapping.offset),
      end: Math.max(0, c.end * mapping.scale + mapping.offset)
    }))
    .filter((c) => c.end > c.start);
}
