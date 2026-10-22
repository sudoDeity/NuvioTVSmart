import test from "node:test";
import assert from "node:assert/strict";
import {
  matchSubtitleTimelines,
  retimeSubtitleCues
} from "../js/core/player/automaticSubtitleSyncMatcher.js";
import { AutomaticSubtitleSyncSession } from "../js/core/player/automaticSubtitleSyncSession.js";

function dialogue(seed = 123, count = 700) {
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let time = 200;
  return Array.from({ length: count }, (_, i) => {
    time += 1 + random() * 7;
    const start = time;
    time += 0.6 + random() * 3;
    return { start, end: time, text: `Line ${i}`, align: "end", position: 70 };
  });
}
const target = dialogue();
const transform = (cues, scale, offset) =>
  cues.map((c) => ({ start: c.start * scale + offset, end: c.end * scale + offset }));
const track = (cues) => ({ trackNumber: 2, cues });

for (const [scale, offset] of [
  [1, 0],
  [1, 2.35],
  [1, -15],
  [1, 179],
  [25 / 24, 3],
  [24000 / 25025, 10],
  [1.017, 7],
  [0.96, 15],
  [1001 / 1000, -4]
]) {
  test(`matches scale ${scale} and offset ${offset}`, () => {
    const mapping = matchSubtitleTimelines(target, [track(transform(target, scale, offset))]);
    assert.ok(mapping);
    for (const cue of [target[0], target[350], target[699]]) {
      assert.ok(
        Math.abs(cue.start * mapping.scale + mapping.offset - (cue.start * scale + offset)) < 0.15
      );
    }
  });
}

test("small timing noise is tolerated without touching text or layout", () => {
  const reference = transform(target, 1.017, 7).map((c, i) => ({
    start: c.start + Math.sin(i) * 0.08,
    end: c.end + Math.cos(i) * 0.08
  }));
  const mapping = matchSubtitleTimelines(target, [track(reference)]);
  assert.ok(mapping);
  const original = structuredClone(target);
  const result = retimeSubtitleCues(target, mapping);
  assert.deepEqual(target, original);
  assert.equal(result[0].text, target[0].text);
  assert.equal(result[0].position, 70);
  assert.equal(result[0].align, "end");
  assert.ok(result[0].start > target[0].start);
});

test("selects informative dialogue when a fixed late window contains continuous captions", () => {
  const center = target[0].start + 0.88 * (target.at(-1).end - target[0].start);
  const continuous = target.map((cue, i) =>
    cue.start > center - 100 && cue.start < center + 100
      ? { ...cue, end: target[i + 1].start + 0.2 }
      : cue
  );
  const mapping = matchSubtitleTimelines(continuous, [track(transform(continuous, 1.017, 7))]);
  assert.ok(mapping);
  for (const cue of [continuous[0], continuous[350], continuous[699]]) {
    assert.ok(
      Math.abs(cue.start * mapping.scale + mapping.offset - (cue.start * 1.017 + 7)) < 0.15
    );
  }
});

test("strong onset agreement accepts differing display durations without losing drift accuracy", () => {
  const reference = transform(target, 1.001, -4).map((cue, i) => ({
    ...cue,
    end: cue.end + (i % 4 === 0 ? 1.3 : 0)
  }));
  const mapping = matchSubtitleTimelines(target, [track(reference)]);
  assert.ok(mapping);
  assert.ok(mapping.coverage >= 0.95);
  for (const cue of [target[0], target[350], target[699]]) {
    assert.ok(
      Math.abs(cue.start * mapping.scale + mapping.offset - (cue.start * 1.001 - 4)) < 0.15
    );
  }
});

test("duration differences do not bypass insufficient onset agreement", () => {
  const reference = transform(target, 1.001, -4).map((cue, i) => ({
    start: cue.start + (i % 10 === 0 ? 1.2 : 0),
    end: cue.end + (i % 10 === 0 ? 1.2 : 0) + (i % 4 === 0 ? 1.3 : 0)
  }));
  assert.equal(matchSubtitleTimelines(target, [track(reference)]), null);
});

test("an unrelated movie with similar dialogue density is rejected", () => {
  for (const seed of [7, 17, 1234, 54321, 555]) {
    assert.equal(matchSubtitleTimelines(target, [track(dialogue(seed))]), null);
  }
});

test("a repeated pattern with equally plausible offsets is rejected", () => {
  const repeated = Array.from({ length: 700 }, (_, i) => ({
    start: 200 + i * 8,
    end: 203 + i * 8
  }));
  assert.equal(matchSubtitleTimelines(repeated, [track(transform(repeated, 1, 2))]), null);
});

test("different cuts and a match confined to the beginning are rejected", () => {
  const recut = target.map((c, i) => ({
    start: c.start + (i < 350 ? 3 : 15),
    end: c.end + (i < 350 ? 3 : 15)
  }));
  assert.equal(matchSubtitleTimelines(target, [track(recut)]), null);
  const partial = transform(target.slice(0, 200), 1, 2);
  assert.equal(matchSubtitleTimelines(target, [track(partial)]), null);
});

test("out-of-range transforms and insufficient input are rejected", () => {
  for (const cues of [
    [],
    target.slice(0, 20),
    null,
    Array(6001).fill(target[0]),
    Array(50).fill(null)
  ]) {
    assert.equal(matchSubtitleTimelines(cues, [track(target)]), null);
  }
  assert.equal(matchSubtitleTimelines(target, [track(transform(target, 1.1, 0))]), null);
  assert.equal(matchSubtitleTimelines(target, [track(transform(target, 1, 400))]), null);
  assert.equal(retimeSubtitleCues(target, { scale: 2, offset: 0 }), null);
});

test("conflicting confident references are rejected; duplicate references agree", () => {
  assert.equal(
    matchSubtitleTimelines(target, [
      track(transform(target, 1, 2)),
      track(transform(target, 1, 6))
    ]),
    null
  );
  assert.ok(
    matchSubtitleTimelines(target, [track(transform(target, 1, 2)), track(transform(target, 1, 2))])
  );
});

function sessionHarness({ reference = [track(target)], enabled = () => true } = {}) {
  const workers = [];
  const applied = [];
  const statuses = [];
  let requests = 0;
  let cancelled = 0;
  const session = new AutomaticSubtitleSyncSession({
    enabled,
    requestReference: () => {
      requests++;
      return {
        promise: Promise.resolve(reference),
        cancel() {
          cancelled++;
        }
      };
    },
    createWorker() {
      const worker = {
        terminated: false,
        terminate() {
          this.terminated = true;
        },
        postMessage(data) {
          this.input = data;
        }
      };
      workers.push(worker);
      return worker;
    },
    onResult: (r) => applied.push(r),
    onStatus: (status) => statuses.push(status)
  });
  return {
    session,
    workers,
    applied,
    statuses,
    get requests() {
      return requests;
    },
    get cancelled() {
      return cancelled;
    }
  };
}
const input = {
  url: "https://media.test/film.mkv",
  headers: {},
  cues: target,
  isCurrent: () => true
};

test("disabled feature does no network or worker work", async () => {
  const h = sessionHarness({ enabled: () => false });
  await h.session.run(input);
  assert.equal(h.requests, 0);
  assert.equal(h.workers.length, 0);
});

test("session passes only timing to the worker and commits once", async () => {
  const h = sessionHarness();
  await h.session.run(input);
  assert.deepEqual(Object.keys(h.workers[0].input.cues[0]), ["start", "end"]);
  h.workers[0].onmessage({ data: { result: { scale: 1, offset: 2 } } });
  assert.equal(h.applied.length, 1);
  assert.equal(h.workers[0].terminated, true);
  assert.equal(h.cancelled, 1);
});

test("subtitle/stream changes discard late results and stop the worker", async () => {
  const h = sessionHarness();
  let current = true;
  await h.session.run({ ...input, isCurrent: () => current });
  current = false;
  h.workers[0].onmessage({ data: { result: { scale: 1, offset: 2 } } });
  assert.equal(h.applied.length, 0);
  assert.equal(h.workers[0].terminated, true);
});

test("cancel during reference loading never starts a worker", async () => {
  const h = sessionHarness();
  let finish;
  let stopped = false;
  h.session.requestReference = () => ({
    promise: new Promise((r) => {
      finish = r;
    }),
    cancel() {
      stopped = true;
    }
  });
  const pending = h.session.run(input);
  h.session.cancel({ clearCache: true });
  finish([track(target)]);
  await pending;
  assert.equal(stopped, true);
  assert.equal(h.workers.length, 0);
  assert.equal(h.session.reference, null);
});

test("negative results are cached per stream and headers", async () => {
  const h = sessionHarness({ reference: null });
  await h.session.run(input);
  await h.session.run(input);
  assert.equal(h.requests, 1);
  await h.session.run({ ...input, headers: { Authorization: "another" } });
  assert.equal(h.requests, 2);
  h.session.cancel({ clearCache: true });
  await h.session.run(input);
  assert.equal(h.requests, 3);
});

test("an old failed reference request cannot cancel a newer operation", async () => {
  const h = sessionHarness();
  let rejectOld;
  const oldReference = new Promise((_, reject) => {
    rejectOld = reject;
  });
  h.session.requestReference = () => ({ promise: oldReference, cancel() {} });
  const first = h.session.run(input);
  let newCancelled = false;
  h.session.requestReference = () => ({
    promise: Promise.resolve([track(target)]),
    cancel() {
      newCancelled = true;
    }
  });
  await h.session.run({ ...input, url: "https://media.test/second.mkv" });
  rejectOld(new Error("aborted"));
  await first;
  assert.equal(newCancelled, false);
  assert.equal(h.workers[0].terminated, false);
  h.workers[0].onmessage({ data: { result: { scale: 1, offset: 0 } } });
  assert.equal(h.applied.length, 1);
});

test("service errors are negatively cached", async () => {
  const h = sessionHarness();
  let requests = 0;
  h.session.requestReference = () => {
    requests++;
    return { promise: Promise.reject(new Error("no reference")), cancel() {} };
  };
  await h.session.run(input);
  await h.session.run(input);
  assert.equal(requests, 1);
});

test("status follows reference loading and only reports synchronized after the result is applied", async () => {
  const h = sessionHarness();
  await h.session.run(input);
  assert.deepEqual(h.statuses, ["checking"]);
  h.session.onResult = () => {
    assert.deepEqual(h.statuses, ["checking"]);
    return true;
  };
  h.workers[0].onmessage({ data: { result: { scale: 1, offset: 2 } } });
  assert.deepEqual(h.statuses, ["checking", "synchronized"]);
  h.workers[0].onerror();
  assert.deepEqual(
    h.statuses,
    ["checking", "synchronized"],
    "late callbacks cannot overwrite success"
  );
});

test("missing references, rejected matches and worker/service failures report unavailable", async () => {
  for (const failure of ["reference", "match", "worker", "service", "apply", "constructor"]) {
    const h = sessionHarness({ reference: failure === "reference" ? null : [track(target)] });
    if (failure === "service")
      h.session.requestReference = () => {
        throw new Error("unavailable");
      };
    if (failure === "constructor")
      h.session.createWorker = () => {
        throw new Error("unsupported");
      };
    if (failure === "apply") h.session.onResult = () => false;
    await h.session.run(input);
    if (failure === "match") h.workers[0].onmessage({ data: { result: null } });
    if (failure === "worker") h.workers[0].onerror();
    if (failure === "apply") h.workers[0].onmessage({ data: { result: { scale: 1, offset: 0 } } });
    assert.deepEqual(h.statuses, ["checking", "unavailable"], failure);
  }
  const h = sessionHarness();
  await h.session.run({ ...input, cues: target.slice(0, 10) });
  assert.deepEqual(h.statuses, ["unavailable"]);
  assert.equal(h.requests, 0);
});

test("reference and worker deadlines end the checking status and ignore late completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const loading = sessionHarness();
  let resolveReference;
  loading.session.requestReference = () => ({
    promise: new Promise((resolve) => {
      resolveReference = resolve;
    }),
    cancel() {}
  });
  const pending = loading.session.run(input);
  t.mock.timers.tick(16000);
  assert.deepEqual(loading.statuses, ["checking", "unavailable"]);
  resolveReference([track(target)]);
  await pending;
  assert.equal(loading.workers.length, 0);
  const working = sessionHarness();
  await working.session.run(input);
  t.mock.timers.tick(4500);
  assert.deepEqual(working.statuses, ["checking", "unavailable"]);
  assert.equal(working.workers[0].terminated, true);
  working.workers[0].onmessage({ data: { result: { scale: 1, offset: 0 } } });
  assert.deepEqual(working.statuses, ["checking", "unavailable"]);
  assert.equal(working.applied.length, 0);
});

test("cancelled or stale operations cannot report status for another selection", async () => {
  const h = sessionHarness();
  await h.session.run(input);
  const oldWorker = h.workers[0];
  await h.session.run(input);
  oldWorker.onerror();
  assert.deepEqual(h.statuses, ["checking", "checking"]);
  h.session.cancel();
  h.workers[1].onmessage({ data: { result: null } });
  assert.deepEqual(h.statuses, ["checking", "checking"]);
  let current = true;
  await h.session.run({ ...input, isCurrent: () => current });
  current = false;
  h.workers[2].onerror();
  assert.deepEqual(h.statuses, ["checking", "checking", "checking"]);
});

test("worker bundle built for Chromium 56 performs the real match in a background worker", async () => {
  const { build } = await import("esbuild");
  const { Worker } = await import("node:worker_threads");
  const { once } = await import("node:events");
  const bundle = await build({
    entryPoints: ["js/core/player/automaticSubtitleSyncWorker.js"],
    bundle: true,
    write: false,
    format: "iife",
    target: ["chrome56"],
    minify: true
  });
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
    global.self = { postMessage: result => parentPort.postMessage(result) };
    ${bundle.outputFiles[0].text}
    parentPort.on("message", data => self.onmessage({data}));`,
    { eval: true }
  );
  try {
    const received = once(worker, "message");
    worker.postMessage({ cues: target, tracks: [track(transform(target, 1.017, 7))] });
    const [{ result }] = await received;
    assert.ok(result);
    assert.ok(Math.abs(result.offset - 7) < 0.1);
  } finally {
    await worker.terminate();
  }
});
