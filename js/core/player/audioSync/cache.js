import { retimeAudioCues } from "./tracker.js";
// Profile-scoped, bounded, best-effort cache. A model or audio track change changes the key.
export function audioMappingCache(profileId, storage = globalThis.localStorage) {
  const name = "nuvio.audioSync." + profileId;
  function read() {
    try {
      const entries = JSON.parse(storage.getItem(name) || "[]");
      return Array.isArray(entries)
        ? entries.slice(0, 200).filter((e) => e && typeof e.key === "string")
        : [];
    } catch (_) {
      return [];
    }
  }
  return {
    get(key) {
      key = fingerprint(key);
      const entry = read().find((e) => e.key === key && Date.now() - e.at < 30 * 86400000);
      return entry && entry.mapping?.confirmed && retimeAudioCues([], entry.mapping)
        ? entry.mapping
        : null;
    },
    set(key, mapping) {
      if (!mapping?.confirmed || !retimeAudioCues([], mapping)) return;
      key = fingerprint(key);
      try {
        storage.setItem(
          name,
          JSON.stringify(
            [{ key, mapping, at: Date.now() }, ...read().filter((e) => e.key !== key)].slice(0, 200)
          )
        );
      } catch (_) {}
    }
  };
}
// Keep URLs and authentication headers out of persisted keys. This is an identity
// digest, not a cryptographic authentication mechanism; it works on legacy TVs.
export function fingerprint(value) {
  let a = 2166136261,
    b = 2246822507,
    c = 3266489909,
    d = 668265263;
  for (let i = 0; i < value.length; i++) {
    const x = value.charCodeAt(i);
    a = Math.imul(a ^ x, 16777619);
    b = Math.imul(b ^ x, 2246822507);
    c = Math.imul(c ^ x, 3266489909);
    d = Math.imul(d ^ x, 668265263);
  }
  return [a, b, c, d].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}
