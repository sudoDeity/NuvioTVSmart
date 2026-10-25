// Dialogue-rich spots spread across the film, with irregular pauses preferred.
export function planAudioSpots(cues, durationMs, count = 3, spotMs = 28000, notBeforeMs = 0) {
  const from = Math.max(180000, notBeforeMs),
    to = durationMs - 360000 - spotMs;
  if (!Number.isFinite(durationMs) || durationMs < 1200000 || to <= from || count < 1) return [];
  const sections = Math.max(1, Math.min(count, Math.floor((to - from) / (2 * spotMs)))),
    spots = [];
  for (let section = 0; section < sections; section++) {
    const a = from + ((to - from) * section) / sections,
      b = from + ((to - from) * (section + 1)) / sections;
    let best = (a + b) / 2,
      bestScore = -1;
    for (let start = a; start <= b; start += 5000) {
      const nearby = cues.filter(
        (c) => c.start * 1000 < start + spotMs + 10000 && c.end * 1000 > start - 10000
      );
      const gaps = nearby.slice(1).map((c, i) => c.start - nearby[i].start);
      const mean = gaps.reduce((n, v) => n + v, 0) / Math.max(1, gaps.length);
      const variation = mean
        ? Math.sqrt(gaps.reduce((n, v) => n + (v - mean) ** 2, 0) / Math.max(1, gaps.length)) / mean
        : 0;
      const score =
        nearby.reduce(
          (n, c) =>
            n +
            Math.max(0, Math.min(c.end * 1000, start + spotMs) - Math.max(c.start * 1000, start)),
          0
        ) *
        (1 + Math.min(1, variation));
      if (score > bestScore) {
        bestScore = score;
        best = start;
      }
    }
    spots.push(Math.round(best));
  }
  const ordered = [spots.splice(Math.floor(spots.length / 2), 1)[0]];
  while (spots.length) {
    let best = 0;
    for (let i = 1; i < spots.length; i++)
      if (
        Math.min(...ordered.map((p) => Math.abs(p - spots[i]))) >
        Math.min(...ordered.map((p) => Math.abs(p - spots[best])))
      )
        best = i;
    ordered.push(spots.splice(best, 1)[0]);
  }
  return ordered;
}
