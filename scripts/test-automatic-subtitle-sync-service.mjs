import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
const require = createRequire(import.meta.url);
const parser = require("../services/webos/src/bitmapSubtitles.js");
const tizen = require("../services/tizen/runtime/tx3g-subtitle-service.cjs");

function size(value) {
  for (let width = 1; width <= 6; width++) {
    if (value >= 2 ** (7 * width) - 1) continue;
    const buffer = Buffer.alloc(width);
    buffer.writeUIntBE(value, 0, width);
    buffer[0] |= 1 << (8 - width);
    return buffer;
  }
  throw new Error("size");
}
function element(id, body) {
  const hex = id.toString(16);
  const tag = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  return Buffer.concat([tag, size(body.length), body]);
}
function uint(value, width = 4) {
  const b = Buffer.alloc(width);
  b.writeUIntBE(value, 0, width);
  return b;
}
function mkv({
  durations = true,
  forced = false,
  trackNumber = 2,
  cueTrack = trackNumber,
  scale = 1000000,
  unrelatedCueCount = 0
} = {}) {
  const track = element(
    0xae,
    Buffer.concat([
      element(0xd7, uint(trackNumber)),
      element(0x83, uint(17, 1)),
      element(0x86, Buffer.from("S_TEXT/UTF8")),
      element(0x55aa, uint(forced ? 1 : 0, 1))
    ])
  );
  const info = element(0x1549a966, element(0x2ad7b1, uint(scale)));
  const otherTracks = unrelatedCueCount
    ? [
        [1, 1, "V_MPEG4/ISO/AVC"],
        [3, 17, "S_HDMV/PGS"],
        [4, 2, "A_AAC"]
      ].map(([number, type, codec]) =>
        element(
          0xae,
          Buffer.concat([
            element(0xd7, uint(number)),
            element(0x83, uint(type, 1)),
            element(0x86, Buffer.from(codec))
          ])
        )
      )
    : [];
  const tracks = element(0x1654ae6b, Buffer.concat([track, ...otherTracks]));
  const cues = element(
    0x1c53bb6b,
    Buffer.concat([
      ...Array.from({ length: unrelatedCueCount }, (_, i) =>
        element(
          0xbb,
          Buffer.concat([
            element(0xb3, uint(i * 100)),
            ...[1, 3, 4].map((number) =>
              element(
                0xb7,
                Buffer.concat([
                  element(0xf7, uint(number)),
                  element(0xf1, uint(1000)),
                  element(0xb2, uint(100))
                ])
              )
            )
          ])
        )
      ),
      ...Array.from({ length: 100 }, (_, i) =>
        element(
          0xbb,
          Buffer.concat([
            element(0xb3, uint(((200000 + i * 6000) * 1000000) / scale)),
            element(
              0xb7,
              Buffer.concat([
                element(0xf7, uint(cueTrack)),
                element(0xf1, uint(1000)),
                ...(durations ? [element(0xb2, uint((2000 * 1000000) / scale))] : [])
              ])
            )
          ])
        )
      )
    ])
  );
  const seek = (offset) =>
    element(
      0x114d9b74,
      element(
        0x4dbb,
        Buffer.concat([
          element(0x53ab, Buffer.from("1c53bb6b", "hex")),
          element(0x53ac, uint(offset))
        ])
      )
    );
  const segment = Buffer.concat([
    seek(seek(0).length + info.length + tracks.length),
    info,
    tracks,
    cues
  ]);
  return Buffer.concat([
    element(0x1a45dfa3, element(0x4282, Buffer.from("matroska"))),
    element(0x18538067, segment)
  ]);
}

async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}
function ranged(body, record = () => {}) {
  return (req, res) => {
    record(req);
    const match = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), body.length - 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${body.length}`,
      "Content-Length": end - start + 1
    });
    res.end(body.subarray(start, end + 1));
  };
}

test("reads real EBML header and indexed timing with bounded HTTP ranges", async (t) => {
  const ranges = [];
  const url = await serverFor(
    t,
    ranged(mkv(), (req) => ranges.push(req.headers.range))
  );
  const result = await parser.getSubtitleSyncTimeline({ url, requestId: "fixture" });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].cues.length, 100);
  assert.deepEqual(result.tracks[0].cues[0], { start: 200, end: 202 });
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0], "bytes=0-524287");
});

test("respects Matroska TimestampScale", async (t) => {
  const url = await serverFor(t, ranged(mkv({ scale: 2000000 })));
  const result = await parser.getSubtitleSyncTimeline({ url, requestId: "scale" });
  assert.deepEqual(result.tracks[0].cues[0], { start: 200, end: 202 });
});

test("video, audio and bitmap Cues do not exhaust the text reference budget", async (t) => {
  const url = await serverFor(t, ranged(mkv({ unrelatedCueCount: 19000 })));
  const result = await parser.getSubtitleSyncTimeline({ url, requestId: "mixed-large-index" });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].cues.length, 100);
  assert.deepEqual(result.tracks[0].cues[0], { start: 200, end: 202 });
});

for (const [name, options] of [
  ["missing durations", { durations: false }],
  ["forced track", { forced: true }],
  ["video-only index", { cueTrack: 1 }]
]) {
  test(`rejects ${name}`, async (t) => {
    const url = await serverFor(t, ranged(mkv(options)));
    await assert.rejects(
      parser.getSubtitleSyncTimeline({ url, requestId: `reject-${name.replaceAll(" ", "-")}` }),
      { code: "SYNC_NO_REFERENCE" }
    );
  });
}

test("does not download a full file when a server ignores Range", async (t) => {
  let calls = 0;
  const url = await serverFor(t, (_req, res) => {
    calls++;
    res.writeHead(200);
    res.end(mkv());
  });
  await assert.rejects(parser.getSubtitleSyncTimeline({ url, requestId: "no-range" }), {
    code: "RANGE_UNAVAILABLE"
  });
  assert.equal(calls, 1);
});

test("rejects invalid Content-Range and interrupted range bodies", async (t) => {
  for (const invalid of [true, false]) {
    const url = await serverFor(t, (_req, res) => {
      res.writeHead(206, { "Content-Range": invalid ? "bytes 1-99/100" : "bytes 0-99/100" });
      res.end(Buffer.alloc(20));
    });
    await assert.rejects(parser.getSubtitleSyncTimeline({ url, requestId: `broken-${invalid}` }), {
      code: invalid ? "RANGE_UNAVAILABLE" : "RANGE_TRUNCATED"
    });
  }
});

test("redirects never forward source credentials to another origin", async (t) => {
  const seen = [];
  const destination = await serverFor(
    t,
    ranged(mkv(), (req) => seen.push(req.headers.authorization))
  );
  const origin = await serverFor(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.writeHead(302, { Location: destination });
    res.end();
  });
  await parser.getSubtitleSyncTimeline({
    url: origin,
    requestId: "redirect",
    headers: { Authorization: "Bearer fixture-token", Range: "ignored", Host: "ignored" }
  });
  assert.deepEqual(seen, [undefined, undefined]);
});

test("redirect loops stop within the request budget", async (t) => {
  let count = 0;
  const url = await serverFor(t, (_req, res) => {
    count++;
    res.writeHead(302, { Location: "/again" });
    res.end();
  });
  await assert.rejects(parser.getSubtitleSyncTimeline({ url, requestId: "redirect-loop" }), {
    code: "TOO_MANY_REDIRECTS"
  });
  assert.equal(count, 5);
});

test("cancelling a stalled read closes the connection", async (t) => {
  let received;
  const started = new Promise((resolve) => {
    received = resolve;
  });
  const url = await serverFor(t, () => received());
  const request = parser.getSubtitleSyncTimeline({ url, requestId: "cancel-me" });
  const rejected = assert.rejects(request, { code: "REQUEST_SUPERSEDED" });
  await started;
  parser.cancelSubtitleSyncTimeline("cancel-me");
  await rejected;
});

test("bounds allocation when an index contains excessive Cues points", () => {
  const cues = element(
    0x1c53bb6b,
    Buffer.concat(Array.from({ length: 30001 }, () => element(0xbb, Buffer.alloc(0))))
  );
  assert.throws(() => parser._test.parseSubtitleSyncCues(cues, 1000000), { code: "SYNC_BUDGET" });
});

test("Tizen HTTP route uses the same parser and returns compact timing", async (t) => {
  const media = await serverFor(t, ranged(mkv()));
  const local = await serverFor(t, tizen.handleRequest);
  const response = await fetch(`${local}/subtitle-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: media, requestId: "tizen-route", headers: {} })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.tracks[0].cues[50].start, 500);
  assert.equal(result.tracks[0].cues[50].end, 502);
  const cancelled = await fetch(`${local}/subtitle-sync-cancel?requestId=already-finished`);
  assert.equal(cancelled.status, 200);
});

test("a cancel message arriving before start prevents any download", async (t) => {
  let calls = 0;
  const url = await serverFor(
    t,
    ranged(mkv(), () => calls++)
  );
  parser.cancelSubtitleSyncTimeline("cancel-before-start");
  await assert.rejects(parser.getSubtitleSyncTimeline({ url, requestId: "cancel-before-start" }), {
    code: "SYNC_CANCELLED"
  });
  assert.equal(calls, 0);
});

test("a malformed redirect is rejected without crashing the service", async (t) => {
  const url = await serverFor(t, (_req, res) => {
    res.writeHead(302, { Location: "http://[invalid" });
    res.end();
  });
  await assert.rejects(parser.getSubtitleSyncTimeline({ url, requestId: "malformed-redirect" }), {
    code: "INVALID_URL"
  });
});

test("bounds child allocation within a malformed Cues point", () => {
  const point = element(
    0xbb,
    Buffer.concat(Array.from({ length: 65 }, () => element(0xec, Buffer.alloc(0))))
  );
  const cues = element(0x1c53bb6b, point);
  assert.throws(() => parser._test.parseSubtitleSyncCues(cues, 1000000), { code: "SYNC_BUDGET" });
});

test("Tizen sync accepts only bounded local JSON POST requests", async (t) => {
  const local = await serverFor(t, tizen.handleRequest);
  const get = await fetch(`${local}/subtitle-sync?headers=secret`);
  assert.equal(get.status, 405);
  const malformed = await fetch(`${local}/subtitle-sync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not valid"
  });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`${local}/subtitle-sync`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: "x".repeat(40000) })
  });
  assert.equal(oversized.status, 413);
  const remote = await fetch(`${local}/subtitle-sync`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ url: "http://example.org", requestId: "blocked" })
  });
  assert.equal(remote.status, 403);
});
