// Player indexes differ by engine. Resolve an audio ordinal, never use an
// AVPlay stream index as a Matroska TrackNumber.
export function resolveAudioSelection(entries, avplayTracks = []) {
  const entry = entries.find((e) => e.selected);
  if (
    !entry ||
    entry.dashAudioTrackIndex != null ||
    entry.hlsAudioTrackIndex != null ||
    entry.manifestAudioTrackId != null
  )
    return null;
  if (Number.isInteger(entry.embeddedAudioTrackIndex) && entry.embeddedAudioTrackIndex >= 0)
    return { audioIndex: entry.embeddedAudioTrackIndex };
  if (Number.isInteger(entry.avplayAudioTrackIndex)) {
    const ordinal = avplayTracks.findIndex(
      (t) => t.avplayTrackIndex === entry.avplayAudioTrackIndex
    );
    return ordinal >= 0 ? { audioIndex: ordinal } : null;
  }
  if (entries.length === 1) return { audioIndex: 0, singleTrack: true };
  return null;
}
