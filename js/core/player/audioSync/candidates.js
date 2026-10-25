export function languageKey(value) {
  const code = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .split("-")[0];
  return (
    {
      eng: "en",
      deu: "de",
      ger: "de",
      fra: "fr",
      fre: "fr",
      spa: "es",
      ita: "it",
      por: "pt",
      nld: "nl",
      dut: "nl",
      ron: "ro",
      rum: "ro",
      pol: "pl",
      rus: "ru",
      heb: "he",
      jpn: "ja",
      zho: "zh",
      chi: "zh",
      ara: "ar"
    }[code] || code
  );
}
export async function loadAudioCandidates(subtitles, selected, load, isCurrent) {
  const language = languageKey(selected?.lang || selected?.language);
  if (!language || ["und", "unknown"].includes(language)) return [];
  const seen = new Set([selected.url]);
  const candidates = (subtitles || [])
    .filter((s) => {
      if (
        !/^https?:\/\//i.test(s.url || "") ||
        seen.has(s.url) ||
        languageKey(s.lang || s.language) !== language
      )
        return false;
      seen.add(s.url);
      return true;
    })
    .slice(0, 5);
  const out = [];
  // At most two simultaneous subtitle requests; stale results never enter the analysis.
  for (let i = 0; i < candidates.length && isCurrent(); i += 2) {
    const pair = await Promise.all(
      candidates.slice(i, i + 2).map(async (subtitle) => {
        try {
          const cues = await load(subtitle);
          return Array.isArray(cues) && cues.length >= 20 && cues.length <= 6000
            ? { id: subtitle.id || subtitle.url, cues, subtitle }
            : null;
        } catch (_) {
          return null;
        }
      })
    );
    if (isCurrent()) out.push(...pair.filter(Boolean));
  }
  return out;
}
