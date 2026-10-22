import { matchSubtitleTimelines } from "./automaticSubtitleSyncMatcher.js";

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: matchSubtitleTimelines(data.cues, data.tracks) });
  } catch (_) {
    self.postMessage({ result: null });
  }
};
