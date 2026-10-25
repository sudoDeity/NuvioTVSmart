import test from "node:test";
import assert from "node:assert/strict";
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k)
};

const { PlayerSettingsStore } = await import("../js/data/local/playerSettingsStore.js");
const { PlayerController } = await import("../js/core/player/playerController.js");
const { PlayerAutomaticSubtitleSyncMethods } =
  await import("../js/ui/screens/player/playerAutomaticSubtitleSync.js");
const { Platform } = await import("../js/platform/index.js");
const { Environment } = await import("../js/platform/environment.js");
const { WebOsLunaService } = await import("../js/platform/webos/webosLunaService.js");
const { createPlayerScreenMethods46 } =
  await import("../js/ui/screens/player/playerScreenMethods-46-schedule-html-subtitle-overlay-render.js");
const { createPlayerScreenMethods56 } =
  await import("../js/ui/screens/player/playerScreenMethods-56-render-subtitle-options-markup.js");
const { I18n } = await import("../js/i18n/index.js");
const { createPlayerScreenMethods57 } =
  await import("../js/ui/screens/player/playerScreenMethods-57-render-subtitle-delay-overlay.js");
const { createPlayerScreenMethods58 } =
  await import("../js/ui/screens/player/playerScreenMethods-58-capture-subtitle-auto-sync-time.js");
const { createSubtitleSyncReferenceRequest } =
  await import("../js/data/repository/subtitleSyncRepository.js");
const { TizenEngineFsService } = await import("../js/platform/tizen/tizenEngineFsService.js");

Platform.isWebOS = () => true;
Platform.isTizen = () => false;
Environment.isWebOS = () => true;
Environment.isTizen = () => false;
WebOsLunaService.isAvailable = () => true;

const cues = Array.from({ length: 100 }, (_, i) => ({
  start: 200 + i * 6,
  end: 202 + i * 6,
  text: `Line ${i}`
}));
let workers = [];
globalThis.Worker = class {
  constructor() {
    workers.push(this);
  }
  postMessage(input) {
    this.input = input;
  }
  terminate() {
    this.stopped = true;
  }
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
function screen() {
  return {
    ...PlayerAutomaticSubtitleSyncMethods,
    playerMountToken: 1,
    subtitleSelectionToken: 10,
    selectedAddonSubtitleId: "sub",
    htmlSubtitleSelectedId: "sub",
    htmlSubtitleCues: cues,
    subtitleDelayMs: 500,
    getTrackProbeUrl: () => "https://media.test/film.mkv",
    getPlaybackCurrentSeconds: () => 106,
    renderHtmlSubtitleOverlayAtCurrentTime() {},
    scheduleHtmlSubtitleOverlayRender() {}
  };
}

function overlayFixture() {
  let markup = "";
  const nodes = new Map();
  const handlers = new Map();
  const selectors = [
    "[data-subtitle-sync-panel]",
    "[data-subtitle-sync-adjustment]",
    "[data-subtitle-sync-manual]",
    "[data-subtitle-sync-state]",
    "[data-subtitle-sync-status]",
    "[data-subtitle-sync-effective]",
    ".player-subtitle-sync-failure-dot",
    ".player-subtitle-delay-slider-fill",
    "[data-subtitle-sync-correction]",
    "[data-automatic-subtitle-sync-delay]",
    "[data-subtitle-sync-value]",
    ".player-subtitle-delay-slider-thumb",
    ...["automatic", "slider", "sync", "reset"].map(
      (name) => `[data-subtitle-delay-focus="${name}"]`
    )
  ];
  for (const selector of selectors) {
    const classes = new Set();
    const node = {
      textContent: "",
      disabled: false,
      dataset: { subtitleDelayFocus: selector.match(/data-subtitle-delay-focus="([^"]+)"/)?.[1] || "" },
      style: {},
      attrs: {},
      classList: {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
        contains: (value) => classes.has(value),
        toggle: (value, active) => (active ? classes.add(value) : classes.delete(value))
      },
      setAttribute(key, value) {
        this.attrs[key] = value;
      },
      focus() {
        document.activeElement = this;
      }
    };
    nodes.set(selector, node);
  }
  return {
    get innerHTML() {
      return markup;
    },
    set innerHTML(value) {
      markup = value;
    },
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener(type, callback) { handlers.set(type, callback); },
    handlers,
    querySelector: (selector) => (markup ? nodes.get(selector) || null : null),
    querySelectorAll: (selector) =>
      selector === ".focused"
        ? [...nodes.values()].filter((node) => node.classList.contains("focused"))
        : [],
    nodes
  };
}
function synchronizationScreen() {
  return {
    ...screen(),
    ...createPlayerScreenMethods57(),
    ...createPlayerScreenMethods58(),
    getSelectedAddonSubtitle: () => ({ id: "sub", url: "https://subs.test/en.srt" }),
    isAssAddonSubtitleActive: () => false,
    persistSubtitleDelayPreference() {},
    applySubtitlePresentationSettings() {},
    renderSubtitleDialog() {},
    updateModalBackdrop() {},
    renderSubtitleTimingDialog() {},
    subtitleDelayOverlayVisible: true,
    subtitleDelayFocusTarget: "slider",
    uiRefs: { subtitleDelayOverlay: overlayFixture() }
  };
}
globalThis.document = { activeElement: null, documentElement: { dir: "ltr" } };

test("new setting defaults to off and remains profile-scoped", () => {
  assert.equal(PlayerSettingsStore.get().subtitleStyle.automaticSync, false);
  PlayerSettingsStore.getForProfile("2");
  PlayerSettingsStore.setForProfile(
    "1",
    { subtitleStyle: { automaticSync: true } },
    { silentSync: true }
  );
  assert.equal(PlayerSettingsStore.getForProfile("1").subtitleStyle.automaticSync, true);
  assert.equal(PlayerSettingsStore.getForProfile("2").subtitleStyle.automaticSync, false);
});

test("player commits corrected cues without changing the manual delay; disabling restores original cues", async () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  WebOsLunaService.request = async () => ({
    returnValue: true,
    tracks: [{ trackNumber: 2, cues }]
  });
  const player = screen();
  player.startAutomaticSubtitleSync({ id: "sub", url: "https://subs.test/en.srt" }, cues, 10);
  await settle();
  assert.equal(workers.length, 1);
  workers[0].onmessage({ data: { result: { scale: 1.001, offset: 2 } } });
  assert.equal(player.htmlSubtitleCues[0].start, cues[0].start * 1.001 + 2);
  assert.equal(player.htmlSubtitleCues[0].text, "Line 0");
  assert.equal(player.subtitleDelayMs, 500);
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: false } }, { silentSync: true });
  player.updateAutomaticSubtitleSyncSetting();
  assert.equal(player.htmlSubtitleCues, cues);
  assert.equal(player.subtitleDelayMs, 500);
});

test("a stale subtitle result cannot replace a newly selected track", async () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = screen();
  player.startAutomaticSubtitleSync({ id: "sub", url: "https://subs.test/en.srt" }, cues, 10);
  await settle();
  player.subtitleSelectionToken++;
  workers[0].onmessage({ data: { result: { scale: 1, offset: 2 } } });
  assert.equal(player.htmlSubtitleCues, cues);
  assert.equal(workers[0].stopped, true);
});

test("automatic delay uses the current video position and excludes manual fine adjustment", async () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = screen();
  player.startAutomaticSubtitleSync({ id: "sub", url: "https://subs.test/en.srt" }, cues, 10);
  await settle();
  workers[0].onmessage({ data: { result: { scale: 1.04, offset: 2 } } });
  // Original subtitle time 100 maps to video time 106; time 200 maps to 210.
  assert.equal(player.getAutomaticSubtitleSyncDelayMs(), 6000);
  player.getPlaybackCurrentSeconds = () => 210;
  assert.equal(player.getAutomaticSubtitleSyncDelayMs(), 10000);
  assert.equal(player.subtitleDelayMs, 500);
  player.subtitleSelectionToken++;
  assert.equal(player.getAutomaticSubtitleSyncDelayMs(), null);
  player.subtitleSelectionToken--;
  player.cancelAutomaticSubtitleSync();
  assert.equal(player.getAutomaticSubtitleSyncDelayMs(), null);
});

test("automatic result updates without exposing manual controls or losing valid focus", async () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = synchronizationScreen();
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  workers[0].onmessage({ data: { result: { scale: 1.04, offset: 2 } } });
  player.renderSubtitleDelayOverlay();
  const overlay = player.uiRefs.subtitleDelayOverlay;
  const value = overlay.nodes.get("[data-subtitle-sync-value]");
  const slider = overlay.nodes.get('[data-subtitle-delay-focus="slider"]');
  assert.match(overlay.innerHTML, /Synchronization/);
  assert.doesNotMatch(
    overlay.innerHTML,
    /Automatic correction|Manual fine adjustment|data-subtitle-sync-correction/
  );
  assert.equal(slider.attrs["aria-valuenow"], "6481");
  assert.equal(value.textContent, "+6.48 s");
  const item = player.renderSubtitleStyleItemMarkup({ id: "delay", label: "Synchronization" }, 0);
  assert.match(item, /Automatic · Synchronized/);
  assert.doesNotMatch(item, /data-automatic-subtitle-sync-delay/);
  player.syncSubtitleDelayOverlayFocusDom({ focus: true });
  const markup = overlay.innerHTML;
  player.getPlaybackCurrentSeconds = () => 210;
  player.refreshAutomaticSubtitleSyncDisplay();
  assert.equal(value.textContent, "+10.48 s");
  player.setSubtitleSynchronizationDelayValue(11000, { showOverlay: true });
  assert.equal(slider.attrs["aria-valuenow"], "11000");
  assert.equal(player.subtitleDelayMs, 1040);
  assert.equal(
    document.activeElement,
    overlay.nodes.get('[data-subtitle-delay-focus="automatic"]')
  );
  assert.equal(slider.disabled, true);
  assert.equal(overlay.innerHTML, markup);
  player.cancelAutomaticSubtitleSync();
  player.renderSubtitleDelayOverlay();
  assert.equal(value.textContent, "+1.04 s");
});

test("existing TV loading path downloads once, mounts original cues, then starts optional analysis", async () => {
  let downloads = 0;
  let started;
  let mountedAtStart;
  PlayerController.setAvPlaySubtitleTrack = () => true;
  const player = {
    ...createPlayerScreenMethods46(),
    subtitleSelectionToken: 10,
    fetchSubtitleRawBody: async () => {
      downloads++;
      return { body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello", contentType: "text/vtt" };
    },
    parseSubtitleCues: () => cues,
    clearMountedExternalSubtitleTracks() {},
    clearHtmlSubtitleOverlay() {},
    destroyAssSubtitleRenderer() {},
    renderHtmlSubtitleOverlayCue() {},
    scheduleHtmlSubtitleOverlayRender() {},
    invalidateTrackDialogCaches() {},
    refreshSubtitleCueStyles() {},
    renderControlButtons() {},
    renderSubtitleDialog() {},
    startAutomaticSubtitleSync(subtitle, input, token) {
      started = { subtitle, input, token };
      mountedAtStart = this.htmlSubtitleCues;
    }
  };
  const subtitle = { id: "sub", url: "https://subs.test/en.vtt" };
  assert.equal(await player.applyTvHtmlAddonSubtitle(subtitle, 0, 10), true);
  assert.equal(downloads, 1);
  assert.equal(mountedAtStart, cues);
  assert.deepEqual(started, { subtitle, input: cues, token: 10 });
});

test("subtitle menu status updates preserve focus and follow the current selection and setting", async () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  WebOsLunaService.request = async () => ({
    returnValue: true,
    tracks: [{ trackNumber: 2, cues }]
  });
  const node = {
    textContent: "",
    hidden: false,
    classList: {
      toggle(_name, hidden) {
        node.hidden = hidden;
      }
    }
  };
  const dialog = {
    innerHTML: "focused menu remains mounted",
    querySelector: (selector) => (selector === "[data-subtitle-sync-summary]" ? node : null)
  };
  const player = {
    ...screen(),
    ...createPlayerScreenMethods58(),
    subtitleDialogVisible: true,
    uiRefs: { subtitleDialog: dialog },
    renderSubtitleDialog() {}
  };
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  assert.equal(node.textContent, "Automatic · Matching…");
  await settle();
  workers[0].onmessage({ data: { result: { scale: 1, offset: 0 } } });
  assert.equal(
    node.textContent,
    "Automatic · Synchronized",
    "zero correction is also a successful match"
  );
  player.subtitleSelectionToken++;
  player.refreshAutomaticSubtitleSyncStatusDisplay();
  assert.equal(node.textContent, "Automatic · No reliable match possible");
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 11);
  await settle();
  workers[1].onmessage({ data: { result: null } });
  assert.equal(node.textContent, "Automatic · No reliable match possible");
  assert.equal(player.subtitleDelayMs, 500);
  assert.equal(dialog.innerHTML, "focused menu remains mounted");
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: false } }, { silentSync: true });
  player.refreshAutomaticSubtitleSyncStatusDisplay();
  assert.equal(node.textContent, "Manual adjustment");
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  player.selectedAddonSubtitleId = null;
  player.refreshAutomaticSubtitleSyncStatusDisplay();
  assert.equal(
    node.textContent,
    "Manual adjustment",
    "embedded tracks and subtitles off have no add-on sync status"
  );
});

test("unsupported adaptive sources report unavailable without starting a worker", () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = { ...screen(), isCurrentSourceAdaptiveManifest: () => true };
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  assert.equal(player.getAutomaticSubtitleSyncStatus(), "unavailable");
  assert.equal(workers.length, 0);
});

test("subtitle menu has one synchronization entry with an accessible status summary", () => {
  const player = synchronizationScreen();
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const markup = player.renderSubtitleStyleItemMarkup({ id: "delay", label: "Synchronization" }, 0);
  assert.match(
    markup,
    /data-subtitle-sync-summary role="status" aria-live="polite" aria-atomic="true">Automatic · No reliable match possible/
  );
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: false } }, { silentSync: true });
  const disabled = player.renderSubtitleStyleItemMarkup(
    { id: "delay", label: "Synchronization" },
    0
  );
  assert.match(disabled, /Manual adjustment/);
  assert.doesNotMatch(disabled, /No reliable match possible/);
});

test("fallback subtitle download starts the same automatic analysis after mounting cues", async () => {
  const originalFetch = globalThis.fetch;
  let started;
  globalThis.fetch = async () => new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello");
  const player = {
    ...createPlayerScreenMethods46(),
    subtitleSelectionToken: 10,
    fetchSubtitleRawBody: async () => null,
    resolveSubtitlePlaybackUrl: async () => "https://subs.test/en.vtt",
    parseSubtitleCues: () => cues,
    clearMountedExternalSubtitleTracks() {},
    clearHtmlSubtitleOverlay() {},
    destroyAssSubtitleRenderer() {},
    renderHtmlSubtitleOverlayCue() {},
    scheduleHtmlSubtitleOverlayRender() {},
    invalidateTrackDialogCaches() {},
    refreshSubtitleCueStyles() {},
    renderControlButtons() {},
    renderSubtitleDialog() {},
    startAutomaticSubtitleSync(subtitle, input, token) {
      started = { subtitle, input, token };
    }
  };
  try {
    const subtitle = { id: "sub", url: "https://subs.test/en.vtt" };
    assert.equal(await player.applyTvHtmlAddonSubtitle(subtitle, 0, 10), true);
    assert.deepEqual(started, { subtitle, input: cues, token: 10 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancelling while Tizen service starts prevents the later fetch", async () => {
  Platform.isWebOS = () => false;
  Platform.isTizen = () => true;
  const originalStart = TizenEngineFsService.ensureStarted;
  let finish;
  TizenEngineFsService.ensureStarted = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  try {
    const request = createSubtitleSyncReferenceRequest({
      url: "https://media.test/film.mkv",
      requestId: "late-service"
    });
    request.cancel();
    finish({ status: "success" });
    assert.equal(await request.promise, null);
  } finally {
    TizenEngineFsService.ensureStarted = originalStart;
    Platform.isWebOS = () => true;
    Platform.isTizen = () => false;
  }
});

test("panel toggle restores cues and replaces manual fallback after a successful automatic match", async () => {
  workers = [];
  PlayerSettingsStore.set(
    { subtitleStyle: { automaticSync: true, fontSize: 130 } },
    { silentSync: true }
  );
  const player = synchronizationScreen();
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  workers[0].onmessage({ data: { result: { scale: 1.04, offset: 2 } } });
  player.setAutomaticSubtitleSyncEnabled(false);
  assert.equal(player.htmlSubtitleCues, cues);
  assert.equal(player.getAutomaticSubtitleSyncMapping(), null);
  assert.equal(player.subtitleDelayMs, 6481);
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 6481);
  assert.equal(PlayerSettingsStore.get().subtitleStyle.fontSize, 130);
  player.setAutomaticSubtitleSyncEnabled(true);
  assert.equal(player.getAutomaticSubtitleSyncStatus(), "checking");
  await settle();
  workers[1].onmessage({ data: { result: { scale: 1, offset: 0 } } });
  assert.equal(player.getAutomaticSubtitleSyncStatus(), "synchronized");
  assert.equal(player.subtitleDelayMs, 0);
});

test("Match clears a negative cache and replaces the manual adjustment after success", async () => {
  workers = [];
  let requests = 0;
  WebOsLunaService.request = async (_uri, { method }) => {
    if (method === "subtitleSyncCancel") return { returnValue: true };
    requests++;
    return { returnValue: true, tracks: requests === 1 ? [] : [{ trackNumber: 2, cues }] };
  };
  const player = synchronizationScreen();
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  assert.equal(player.getAutomaticSubtitleSyncStatus(), "unavailable");
  assert.equal(player.retryAutomaticSubtitleSync(), true);
  await settle();
  assert.equal(requests, 2);
  assert.equal(workers[0].input.cues[0].start, cues[0].start);
  assert.equal(player.subtitleDelayMs, 500);
  workers[0].onmessage({ data: { result: { scale: 1, offset: 2 } } });
  assert.equal(player.getAutomaticSubtitleSyncStatus(), "synchronized");
  assert.equal(player.subtitleDelayMs, 0);
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 2000);
});

test("Match keeps the complete slider value while checking and after an unsuccessful retry", async () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  WebOsLunaService.request = async () => ({
    returnValue: true,
    tracks: [{ trackNumber: 2, cues }]
  });
  const player = synchronizationScreen();
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  await settle();
  workers[0].onmessage({ data: { result: { scale: 1, offset: 0.083 } } });
  player.setSubtitleSynchronizationDelayValue(183);
  const correctedCues = player.htmlSubtitleCues;
  let persisted = 0;
  player.persistSubtitleDelayPreference = () => persisted++;
  player.retryAutomaticSubtitleSync();
  assert.equal(player.getAutomaticSubtitleSyncStatus(), "checking");
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 183);
  assert.equal(player.htmlSubtitleCues, correctedCues);
  await settle();
  workers[1].onmessage({ data: { result: null } });
  assert.equal(player.getAutomaticSubtitleSyncStatus(), "unavailable");
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 183);
  assert.equal(player.htmlSubtitleCues, correctedCues);
  assert.equal(persisted, 0);
  player.retryAutomaticSubtitleSync();
  await settle();
  workers[2].onmessage({ data: { result: { scale: 1, offset: 0.083 } } });
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 83);
  assert.equal(player.subtitleDelayMs, 0);
  assert.equal(persisted, 1);
});

test("a stale Match cannot reset the new track's manual delay", async () => {
  workers = [];
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  WebOsLunaService.request = async () => ({
    returnValue: true,
    tracks: [{ trackNumber: 2, cues }]
  });
  const player = synchronizationScreen();
  player.retryAutomaticSubtitleSync();
  await settle();
  player.subtitleSelectionToken++;
  player.subtitleDelayMs = 700;
  workers[0].onmessage({ data: { result: { scale: 1, offset: 0.083 } } });
  assert.equal(player.subtitleDelayMs, 700);
  assert.equal(player.htmlSubtitleCues, cues);
});

test("remote navigates all panel actions, skips disabled actions and resets only manual correction", () => {
  const player = synchronizationScreen();
  player.renderSubtitleDelayOverlay();
  const key = (code) => player.handleSubtitleDelayOverlayKey({ keyCode: code });
  key(38);
  assert.equal(player.subtitleDelayFocusTarget, "automatic");
  key(39);
  assert.equal(player.subtitleDelayFocusTarget, "automatic");
  key(40);
  assert.equal(player.subtitleDelayFocusTarget, "slider");
  key(37);
  assert.equal(player.subtitleDelayMs, 400);
  key(39);
  assert.equal(player.subtitleDelayMs, 500);
  key(40);
  assert.equal(player.subtitleDelayFocusTarget, "sync");
  key(39);
  assert.equal(player.subtitleDelayFocusTarget, "reset");
  key(13);
  assert.equal(player.subtitleDelayMs, 0);
  assert.equal(PlayerSettingsStore.get().subtitleStyle.automaticSync, true);
  player.getSelectedAddonSubtitle = () => null;
  player.subtitleDelayFocusTarget = "slider";
  key(40);
  assert.equal(player.subtitleDelayFocusTarget, "reset");
  key(38);
  key(38);
  key(39);
  assert.equal(player.subtitleDelayFocusTarget, "automatic");
  player.getSelectedAddonSubtitle = () => ({ id: "sub" });
  document.documentElement.dir = "rtl";
  key(37);
  assert.equal(player.subtitleDelayFocusTarget, "automatic");
  document.documentElement.dir = "ltr";
});

test("aligning a spoken line subtracts the applied automatic mapping instead of counting it twice", () => {
  const player = {
    ...synchronizationScreen(),
    getSubtitleAutoSyncVisibleCues: createPlayerScreenMethods56().getSubtitleAutoSyncVisibleCues
  };
  player.automaticSubtitleSyncApplied = {
    scale: 1.04,
    offset: 2,
    subtitleId: "sub",
    selectionToken: 10,
    mountToken: 1,
    url: player.getTrackProbeUrl()
  };
  player.subtitleAutoSyncCues = [{ startTimeMs: 100000, endTimeMs: 102000, text: "Line" }];
  player.subtitleAutoSyncCapturedVideoMs = 106300;
  const [cue] = player.getSubtitleAutoSyncVisibleCues(106300);
  assert.equal(cue.startTimeMs, 106000);
  assert.equal(cue.originalStartTimeMs, 100000);
  player.applySubtitleAutoSyncCue(cue);
  assert.equal(player.subtitleDelayMs, 0);
  assert.equal(player.getAutomaticSubtitleSyncMapping().scale, 1.04);
  assert.equal(player.subtitleDelayOverlayVisible, true);
  assert.equal(player.subtitleTimingDialogVisible, false);
});

test("cancelling line selection returns to the same synchronization panel without changing delay", () => {
  const player = synchronizationScreen();
  player.subtitleTimingDialogVisible = true;
  let returned = false;
  player.showSubtitleDelayOverlay = () => {
    returned = true;
  };
  player.dismissSubtitleTimingDialog();
  assert.equal(returned, true);
  assert.equal(player.subtitleDelayMs, 500);
});

test("subtitle synchronization and alignment remain English in German locale", async () => {
  const { readFile } = await import("node:fs/promises");
  const { load } = await import("cheerio");
  const messages = {};
  for (const [locale, folder] of [
    ["en", "values"],
    ["de", "values-de"],
    ["fr", "values-fr"]
  ]) {
    const $ = load(await readFile(`res/${folder}/strings.xml`, "utf8"), { xmlMode: true });
    messages[locale] = { ...messages.en };
    $("string[name]").each((_, node) => {
      messages[locale][$(node).attr("name")] = $(node).text();
    });
  }
  const originalXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    open(_method, url) {
      this.url = url;
    }
    send() {
      queueMicrotask(() => {
        this.status = 200;
        this.responseText = JSON.stringify(messages[this.url.includes("de.json") ? "de" : this.url.includes("fr.json") ? "fr" : "en"]);
        this.onload();
      });
    }
  };
  try {
    await I18n.init("de");
    const player = synchronizationScreen();
    player.renderSubtitleDelayOverlay();
    const markup = player.uiRefs.subtitleDelayOverlay.innerHTML;
    for (const label of [
      "Synchronization",
      "Automatic",
      "Subtitle offset",
      "Subtitles earlier",
      "Subtitles later",
      "Align line",
      "Reset"
    ])
      assert.ok(markup.includes(label), label);
    assert.equal(
      player.uiRefs.subtitleDelayOverlay.nodes.get("[data-subtitle-sync-value]").textContent,
      "+500 ms"
    );
    for (const key of [
      "subtitle_sync_title",
      "subtitle_sync_align_short",
      "subtitle_sync_auto_mode",
      "player_sync_line",
      "subtitle_timing_captured_at",
      "subtitle_timing_capturing",
      "subtitle_timing_file_no_lines",
      "subtitle_timing_load_lines_failed"
    ])
      assert.equal(messages.de[key], messages.en[key], key);
    const timing = { innerHTML: "", classList: { toggle() {} }, setAttribute() {} };
    player.uiRefs.subtitleTimingDialog = timing;
    player.subtitleTimingDialogVisible = true;
    player.subtitleTimingStage = "wait";
    player.syncSubtitleTimingFocusDom = () => true;
    createPlayerScreenMethods58().renderSubtitleTimingDialog.call(player);
    assert.match(timing.innerHTML, /Capture time/);
    assert.doesNotMatch(timing.innerHTML, /Zeitpunkt erfassen|Synchronisation|Untertitelzeilen/);
    await I18n.init("fr");
    assert.equal(I18n.t("player_sync_line"), messages.en.player_sync_line);
    assert.equal(I18n.t("subtitle_timing_sync_button"), messages.en.subtitle_timing_sync_button);
    assert.equal(I18n.t("subtitle_sync_title"), messages.en.subtitle_sync_title);
    assert.equal(I18n.t("subtitle_automatic_sync_synchronized"), messages.en.subtitle_automatic_sync_synchronized);
  } finally {
    await I18n.init("en");
    globalThis.XMLHttpRequest = originalXhr;
  }
});

test("automatic mode hides manual tools; failure and switching off expose them with valid focus", async () => {
  workers = [];
  WebOsLunaService.request = async () => ({
    returnValue: true,
    tracks: [{ trackNumber: 2, cues }]
  });
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = synchronizationScreen();
  player.renderSubtitleDelayOverlay();
  const nodes = player.uiRefs.subtitleDelayOverlay.nodes;
  const node = (name) => nodes.get(`[data-subtitle-delay-focus="${name}"]`);
  const hidden = (name) => nodes.get(`[data-subtitle-sync-${name}]`).classList.contains("hidden");
  player.startAutomaticSubtitleSync({ id: "sub" }, cues, 10);
  assert.equal(hidden("manual"), true);
  assert.equal(hidden("adjustment"), true, "no stale result while checking");
  for (const name of ["slider", "sync", "reset"]) assert.equal(node(name).disabled, true);
  assert.doesNotMatch(player.uiRefs.subtitleDelayOverlay.innerHTML, /data-subtitle-delay-focus="retry"/);
  assert.equal(player.subtitleDelayFocusTarget, "automatic");
  player.subtitleDelayFocusTarget = "slider";
  player.handleSubtitleDelayOverlayKey({ keyCode: 39 });
  assert.equal(player.subtitleDelayMs, 500, "stale slider focus cannot change a hidden control");
  await settle();
  workers[0].onmessage({ data: { result: null } });
  assert.equal(hidden("manual"), false);
  assert.equal(hidden("adjustment"), false);
  assert.equal(node("slider").disabled, false);
  assert.equal(node("sync").disabled, false);
  assert.equal(nodes.get(".player-subtitle-sync-failure-dot").classList.contains("hidden"), false);
  player.subtitleDelayFocusTarget = "slider";
  player.handleSubtitleDelayOverlayKey({ keyCode: 39 });
  assert.equal(player.subtitleDelayMs, 600);
  player.retryAutomaticSubtitleSync();
  assert.equal(hidden("manual"), true);
  assert.equal(document.activeElement, node("automatic"));
  await settle();
  workers[1].onmessage({ data: { result: { scale: 1, offset: 0.083 } } });
  assert.equal(hidden("manual"), true);
  // The automatic result is in the status row; the adjustment container
  // contains only manual tools and stays hidden after a successful match.
  assert.equal(hidden("adjustment"), true);
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 83);
  assert.equal(nodes.get(".player-subtitle-sync-failure-dot").classList.contains("hidden"), true);
  let opened = false;
  player.openSubtitleTimingDialog = () => {
    opened = true;
  };
  player.activateSubtitleSynchronizationAction("sync");
  player.activateSubtitleSynchronizationAction("reset");
  assert.equal(opened, false);
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 83);
  for (const keyCode of [40, 39, 38]) player.handleSubtitleDelayOverlayKey({ keyCode });
  assert.equal(player.subtitleDelayFocusTarget, "automatic");
  player.setAutomaticSubtitleSyncEnabled(false);
  assert.equal(hidden("manual"), false);
  assert.equal(node("slider").disabled, false);
  assert.equal(hidden("state"), true, "off switch already communicates manual mode");
  player.activateSubtitleSynchronizationAction("sync");
  assert.equal(opened, true);
});

test("automatic matching and direct adjustment control the same effective slider value", () => {
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = synchronizationScreen();
  player.getPlaybackCurrentSeconds = () => 106.5;
  player.automaticSubtitleSyncApplied = {
    scale: 1.04,
    offset: 2,
    subtitleId: "sub",
    selectionToken: 10,
    mountToken: 1,
    url: player.getTrackProbeUrl()
  };
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 6500);
  player.setSubtitleSynchronizationDelayValue(7000, { showOverlay: true });
  assert.equal(player.subtitleDelayMs, 1020);
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 7000);
  player.handleSubtitleDelayOverlayKey({ keyCode: 39 });
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 7100);
  assert.equal(player.getAutomaticSubtitleSyncMapping().scale, 1.04);
  const totalSecondsAtCue =
    player.getAutomaticSubtitleSyncCueTimeMs(100000) / 1000 + player.subtitleDelayMs / 1000;
  assert.equal(totalSecondsAtCue, 107.124);
});

test("shared slider handles negative automatic corrections and keeps advancing drift after reset", () => {
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = synchronizationScreen();
  player.subtitleDelayMs = 0;
  player.getPlaybackCurrentSeconds = () => 95;
  player.automaticSubtitleSyncApplied = {
    scale: 0.96,
    offset: -1,
    subtitleId: "sub",
    selectionToken: 10,
    mountToken: 1,
    url: player.getTrackProbeUrl()
  };
  assert.equal(player.getSubtitleSynchronizationDelayMs(), -5000);
  player.setSubtitleSynchronizationDelayValue(-4900);
  assert.equal(player.subtitleDelayMs, 96);
  assert.equal(player.getSubtitleSynchronizationDelayMs(), -4900);
  player.activateSubtitleSynchronizationAction("reset");
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 0);
  assert.equal(player.getAutomaticSubtitleSyncMapping().scale, 0.96);
  assert.equal(PlayerSettingsStore.get().subtitleStyle.automaticSync, true);
  player.getPlaybackCurrentSeconds = () => 195;
  assert.equal(player.getSubtitleSynchronizationDelayMs(), -4167);
});

test("shared slider falls back to ordinary delay without a mapping and does not clip a large automatic correction", () => {
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = synchronizationScreen();
  player.setSubtitleSynchronizationDelayValue(-1200, { showOverlay: true });
  assert.equal(player.subtitleDelayMs, -1200);
  assert.equal(player.getSubtitleSynchronizationDelayMs(), -1200);
  player.subtitleDelayMs = 0;
  player.getPlaybackCurrentSeconds = () => 20000;
  player.automaticSubtitleSyncApplied = {
    scale: 1.06,
    offset: 2,
    subtitleId: "sub",
    selectionToken: 10,
    mountToken: 1,
    url: player.getTrackProbeUrl()
  };
  player.refreshSubtitleSynchronizationOverlay();
  const slider = player.uiRefs.subtitleDelayOverlay.nodes.get(
    '[data-subtitle-delay-focus="slider"]'
  );
  assert.ok(Number(slider.attrs["aria-valuenow"]) > 180000);
  assert.equal(Number(slider.attrs["aria-valuenow"]), player.getSubtitleSynchronizationDelayMs());
  assert.ok(Number(slider.attrs["aria-valuemax"]) >= player.getSubtitleSynchronizationDelayMs());
});

test("slider uses fine central range, supports clicks and pointer dragging", () => {
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: false } }, { silentSync: true });
  const player = synchronizationScreen();
  const overlay = player.uiRefs.subtitleDelayOverlay;
  player.renderSubtitleDelayOverlay();
  const slider = overlay.nodes.get('[data-subtitle-delay-focus="slider"]');
  slider.getBoundingClientRect = () => ({ left: 20, width: 400 });
  slider.setPointerCapture = () => {};
  assert.deepEqual(player.getSubtitleSyncSliderRange(200), { minimum: -5000, maximum: 5000 });
  assert.deepEqual(player.getSubtitleSyncSliderRange(15000), { minimum: -30000, maximum: 30000 });
  assert.equal(player.handleSubtitleDelayOverlayPointer(
    { closest: () => slider }, { clientX: 320 }
  ), true);
  assert.equal(player.subtitleDelayMs, 2500);
  overlay.handlers.get("pointerdown")({ target: { closest: () => slider }, clientX: 220, pointerId: 5 });
  assert.equal(player.subtitleDelayMs, 0);
  overlay.handlers.get("pointermove")({ clientX: 120, pointerId: 5 });
  assert.equal(player.subtitleDelayMs, -2500);
  overlay.handlers.get("pointerup")({ pointerId: 5 });
  overlay.handlers.get("pointermove")({ clientX: 320, pointerId: 5 });
  assert.equal(player.subtitleDelayMs, -2500, "released pointer must not change delay");
});

test("Reset restores original cue mapping when FPS drift exceeds manual delay bounds", () => {
  PlayerSettingsStore.set({ subtitleStyle: { automaticSync: true } }, { silentSync: true });
  const player = synchronizationScreen();
  player.subtitleDelayMs = 0;
  player.getPlaybackCurrentSeconds = () => 7200;
  player.automaticSubtitleSyncApplied = {
    scale: 1.04, offset: 0, subtitleId: "sub",
    selectionToken: 10, mountToken: 1, url: player.getTrackProbeUrl()
  };
  const originalCues = player.htmlSubtitleCues;
  player.automaticSubtitleSyncOriginalCues = { subtitleId: "sub", selectionToken: 10, cues: originalCues };
  assert.ok(player.getSubtitleSynchronizationDelayMs() > 180000);
  player.activateSubtitleSynchronizationAction("reset");
  assert.equal(player.getSubtitleSynchronizationDelayMs(), 0);
  assert.equal(player.subtitleDelayMs, 0);
  assert.equal(player.getAutomaticSubtitleSyncMapping(), null);
  assert.equal(player.htmlSubtitleCues, originalCues);
});
