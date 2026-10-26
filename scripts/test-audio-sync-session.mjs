import test from "node:test";
import assert from "node:assert/strict";
import { AudioSubtitleSyncSession } from "../js/core/player/audioSync/session.js";
import { loadAudioCandidates } from "../js/core/player/audioSync/candidates.js";
const cues = Array.from({ length: 50 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 2,
  text: `Line ${i}`
}));
const mapping = { confirmed: true, segments: [{ fromMediaMs: 0, scale: 1, shiftMs: 2300 }] };
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};
function harness(options = {}) {
  const state = {
    current: true,
    enabled: true,
    selection: { audioIndex: 0 },
    requests: [],
    results: [],
    statuses: [],
    stopped: false
  };
  const worker = {
    terminate() {
      state.stopped = true;
    },
    postMessage(data) {
      state.messages ||= [];
      state.messages.push(data);
      if (options.hang) return;
      const reply =
        data.type === "init"
          ? { type: "ready", version: "model-v6" }
          : data.type === "sample"
            ? { type: "analysis", result: { id: "selected", mapping, status: "locked" } }
            : { type: "adopted" };
      queueMicrotask(() =>
        worker.onmessage({ data: options.workerError ? { type: "error" } : reply })
      );
    }
  };
  const session = new AudioSubtitleSyncSession({
    requestSample:
      options.requestSample ||
      ((input) => {
        state.requests.push(input);
        return {
          promise: Promise.resolve({
            pcm: new ArrayBuffer(1024),
            startMs: input.positionMs,
            networkBytes: 2000
          }),
          cancel() {}
        };
      }),
    releaseDecoder: () => {
      state.decoderReleases = (state.decoderReleases || 0) + 1;
    },
    createWorker: () => worker,
    enabled: () => state.enabled,
    onStatus: (status) => {
      state.statuses.push(status);
      if (status === "synchronized" && !options.keepRunning) state.current = false;
    },
    onResult: (result) => {
      state.results.push(result);
      return true;
    },
    getPosition: () => 100000,
    getDuration: () => 7200000,
    getSelection: () => state.selection,
    ...options
  });
  return {
    state,
    session,
    run: () =>
      session.run({
        url: "https://media.test/film.mkv",
        headers: { Authorization: "private" },
        cues,
        subtitleId: "selected",
        isCurrent: () => state.current
      })
  };
}
test("disabled feature does not create a worker or read media", async () => {
  const h = harness();
  h.state.enabled = false;
  await h.run();
  assert.equal(h.state.messages, undefined);
  assert.equal(h.state.requests.length, 0);
});
test("fallback initializes model, requests selected audio and commits confirmed mapping", async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.state.results, [mapping]);
  assert.deepEqual(h.state.statuses, ["checking", "synchronized"]);
  assert.equal(h.state.requests[0].selection.audioIndex, 0);
  assert.equal(h.state.requests[0].headers.Authorization, "private");
  assert.equal(h.state.stopped, true);
  assert.ok(h.state.decoderReleases >= 2);
});
test("incompatible model reports unavailable before requesting media", async () => {
  const h = harness({ workerError: true });
  await h.run();
  assert.equal(h.state.requests.length, 0);
  assert.deepEqual(h.state.statuses, ["checking", "unavailable"]);
});
test("cancellation during decoder wait cancels the request and ignores late results", async () => {
  let resolveSample,
    cancelled = false;
  const h = harness({
    requestSample: () => ({
      promise: new Promise((resolve) => {
        resolveSample = resolve;
      }),
      cancel() {
        cancelled = true;
        resolveSample({ pcm: new ArrayBuffer(1024), startMs: 0, networkBytes: 1 });
      }
    })
  });
  const run = h.run();
  await settle();
  h.session.cancel();
  await run;
  assert.equal(cancelled, true);
  assert.equal(h.state.stopped, true);
  assert.deepEqual(h.state.results, []);
});
test("a different audio track invalidates the session and cannot inherit a late mapping", async () => {
  let resolveSample;
  const h = harness({
    requestSample: () => ({
      promise: new Promise((resolve) => {
        resolveSample = resolve;
      }),
      cancel() {}
    })
  });
  const run = h.run();
  await settle();
  h.state.selection = { audioIndex: 1 };
  resolveSample({ pcm: new ArrayBuffer(1024), startMs: 0, networkBytes: 1 });
  await run;
  assert.deepEqual(h.state.results, []);
  assert.equal(h.state.stopped, true);
});
test("init deadline terminates an unresponsive worker and clears checking status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness({ hang: true }),
    run = h.run();
  await Promise.resolve();
  t.mock.timers.tick(15001);
  await run;
  assert.equal(h.state.stopped, true);
  assert.equal(h.state.statuses.at(-1), "unavailable");
});
test("same-language alternatives use at most two downloads and ignore cancelled work", async () => {
  const selected = { url: "https://sub/0", lang: "en" };
  const others = Array.from({ length: 9 }, (_, i) => ({
    url: `https://sub/${i + 1}`,
    lang: i < 7 ? "eng" : "de"
  }));
  let active = 0,
    max = 0,
    current = true;
  const loaded = await loadAudioCandidates(
    others,
    selected,
    async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return cues;
    },
    () => current
  );
  assert.equal(loaded.length, 5);
  assert.equal(max, 2);
  const stale = await loadAudioCandidates(
    others,
    selected,
    async () => {
      current = false;
      return cues;
    },
    () => current
  );
  assert.deepEqual(stale, []);
});
