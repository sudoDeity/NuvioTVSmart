import test from "node:test";
import assert from "node:assert/strict";
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) || null,
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k)
};
const { PlayerSettingsStore } = await import("../js/data/local/playerSettingsStore.js");
const { PlayerAutomaticSubtitleSyncMethods } =
  await import("../js/ui/screens/player/playerAutomaticSubtitleSync.js");
const { PlayerController } = await import("../js/core/player/playerController.js");
const { Platform } = await import("../js/platform/index.js");
const { WebOsLunaService } = await import("../js/platform/webos/webosLunaService.js");
Platform.isWebOS = () => true;
Platform.isTizen = () => false;
WebOsLunaService.isAvailable = () => true;
WebOsLunaService.request = async () => ({ returnValue: true, tracks: [] });
PlayerController.getAvPlayAudioTracks = () => [];
const workers = [];
globalThis.Worker = class {
  constructor(url) {
    this.url = url;
    workers.push(this);
  }
  postMessage(data) {
    this.input = data;
  }
  terminate() {
    this.stopped = true;
  }
};
const cues = Array.from({ length: 50 }, (_, i) => ({
  start: 10 + i * 5,
  end: 12 + i * 5,
  text: `Line ${i}`
}));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const mapping = {
  confirmed: true,
  segments: [
    { fromMediaMs: 0, scale: 1, shiftMs: 2000 },
    { fromMediaMs: 150000, scale: 1, shiftMs: 4000 }
  ]
};
function screen() {
  PlayerSettingsStore.set(
    { subtitleStyle: { automaticSync: true, audioSync: true } },
    { silentSync: true }
  );
  return {
    ...PlayerAutomaticSubtitleSyncMethods,
    playerMountToken: 1,
    subtitleSelectionToken: 10,
    selectedAddonSubtitleId: "sub",
    htmlSubtitleSelectedId: "sub",
    htmlSubtitleCues: cues,
    subtitleDelayMs: 500,
    getTrackProbeUrl: () => "https://media.test/film.mkv",
    getPlaybackCurrentSeconds: () => 100,
    getPlaybackDurationSeconds: () => 7200,
    getAudioEntries: () => [{ selected: true, embeddedAudioTrackIndex: 0 }],
    renderHtmlSubtitleOverlayAtCurrentTime() {},
    scheduleHtmlSubtitleOverlayRender() {},
    setSubtitleDelayValue(ms) {
      this.subtitleDelayMs = ms;
    },
    getSelectedAddonSubtitle: () => ({ id: "sub", url: "https://sub.test/file.srt", lang: "en" })
  };
}
test("missing embedded reference starts the audio fallback and complete cancellation stops both workers", async () => {
  const s = screen();
  s.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  assert.ok(s.audioSubtitleSyncSession);
  assert.equal(workers.at(-1).url, "assets/runtime/audio-sync-worker.js");
  assert.equal(workers.at(-1).input.type, "init");
  assert.equal(s.getAutomaticSubtitleSyncStatus(), "checking");
  s.cancelAutomaticSubtitleSync(true);
  await settle();
  assert.equal(workers.at(-1).stopped, true);
  assert.equal(s.audioSubtitleSyncSession, null);
});
test("audio fallback respects its own switch and leaves original subtitles rendered", async () => {
  const s = screen();
  PlayerSettingsStore.set({ subtitleStyle: { audioSync: false } }, { silentSync: true });
  s.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  assert.ok(!s.audioSubtitleSyncSession);
  assert.equal(s.getAutomaticSubtitleSyncStatus(), "unavailable");
  assert.equal(s.htmlSubtitleCues, cues);
  s.cancelAutomaticSubtitleSync(true);
});
test("piecewise mappings update display delay at the playhead without double-counting manual adjustment", async () => {
  const s = screen();
  s.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  assert.equal(s.audioSubtitleSyncSession.onResult(mapping), true);
  assert.equal(s.htmlSubtitleCues[0].start, cues[0].start + 2);
  assert.equal(s.getSubtitleSynchronizationDelayMs(), 2500);
  s.getPlaybackCurrentSeconds = () => 200;
  assert.equal(s.getSubtitleSynchronizationDelayMs(), 4500);
  s.getAudioEntries = () => [{ selected: true, embeddedAudioTrackIndex: 1 }];
  assert.equal(s.getAutomaticSubtitleSyncMapping(), null);
  assert.equal(s.audioSubtitleSyncSession.onResult(mapping), false);
  s.cancelAutomaticSubtitleSync(true);
  await settle();
});
test("disabling audio sync restores original timing and preserves the manual delay", async () => {
  const s = screen();
  s.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  s.audioSubtitleSyncSession.onResult(mapping);
  PlayerSettingsStore.set({ subtitleStyle: { audioSync: false } }, { silentSync: true });
  s.updateAutomaticSubtitleSyncSetting();
  await settle();
  assert.equal(s.htmlSubtitleCues, cues);
  assert.equal(s.subtitleDelayMs, 500);
  assert.equal(s.getAutomaticSubtitleSyncMapping(), null);
  s.cancelAutomaticSubtitleSync(true);
});
test("a subtitle switch prevents an in-flight audio mapping from being applied", async () => {
  const s = screen();
  s.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  const audio = s.audioSubtitleSyncSession;
  s.subtitleSelectionToken++;
  assert.equal(audio.onResult(mapping), false);
  assert.equal(s.htmlSubtitleCues, cues);
  s.cancelAutomaticSubtitleSync(true);
  await settle();
});
