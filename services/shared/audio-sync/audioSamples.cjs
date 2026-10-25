const crypto = require("crypto");
const { URL } = require("url");
const media = require("./media.cjs");
const { extractAudioSample } = require("./audioSampleSource.cjs");
const fs = require("fs"),
  path = require("path");
let assetsPath = null;
const cancelled = new Map();
let active = null;
let ready = null;
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id);
function cancel(requestId) {
  if (!validId(requestId)) return;
  cancelled.set(requestId, Date.now() + 30000);
  while (cancelled.size > 32) cancelled.delete(cancelled.keys().next().value);
  if (active?.id === requestId) media.cancelRequestContext(active.context);
  if (ready?.requestId === requestId) {
    clearTimeout(ready.timer);
    ready = null;
  }
}
async function create(options) {
  const id = options.requestId;
  if (!validId(id)) throw Error("AUDIO_SAMPLE_REQUEST");
  if (cancelled.get(id) > Date.now()) throw Error("AUDIO_SAMPLE_CANCELLED");
  if (active || ready) throw Error("AUDIO_SAMPLE_BUSY");
  const url = new URL(options.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw Error("AUDIO_SAMPLE_URL");
  const headers = {};
  for (const key of Object.keys(options.headers || {}).slice(0, 20)) {
    const value = String(options.headers[key]);
    if (
      /^(authorization|cookie|referer|origin|user-agent|accept|x-[a-z0-9-]+)$/i.test(key) &&
      value.length <= 4096 &&
      !/[\r\n]/.test(value)
    )
      headers[key] = value;
  }
  const maxBytes = Math.min(
    64 * 1024 * 1024,
    Math.max(1, Number(options.maxBytes) || 32 * 1024 * 1024)
  );
  const context = {
    cancelled: false,
    requests: new Set(),
    requestCount: 0,
    bytes: 0,
    maxBytes,
    deadline: Date.now() + 30000,
    origin: url.origin,
    headers
  };
  const state = { id, context };
  active = state;
  const timer = setTimeout(() => media.cancelRequestContext(context), 30000);
  try {
    const sample = await extractAudioSample(options, context);
    if (context.cancelled) throw Error("AUDIO_SAMPLE_CANCELLED");
    const token = crypto.randomBytes(24).toString("hex");
    const { input, ...metadata } = sample;
    ready = {
      requestId: id,
      token,
      input,
      timer: setTimeout(() => {
        ready = null;
      }, 10000)
    };
    return {
      returnValue: true,
      requestId: id,
      path: "/audio-samples/" + token,
      byteLength: input.length,
      ...metadata
    };
  } finally {
    clearTimeout(timer);
    media.cancelRequestContext(context);
    context.httpAgent?.destroy();
    context.httpsAgent?.destroy();
    if (active === state) active = null;
  }
}
function handle(req, res) {
  const pathname = String(req.url || "").split("?")[0];
  const asset = pathname.match(
    /^\/audio-transcode\/assets\/(ffmpeg-core\.js|ffmpeg-core\.wasm|sample-worker\.js)$/
  );
  if (
    !pathname.startsWith("/audio-samples/") &&
    !["/audio-sample-create", "/audio-sample-cancel"].includes(pathname) &&
    !(asset && assetsPath)
  )
    return false;
  const local = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket?.remoteAddress || "");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  let originAllowed = !req.headers.origin || req.headers.origin === "null";
  try {
    originAllowed =
      originAllowed || /^(localhost|127\.0\.0\.1)$/.test(new URL(req.headers.origin).hostname);
  } catch (_) {}
  if (!local || !originAllowed) {
    res.statusCode = 403;
    res.end();
    return true;
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (asset && assetsPath) {
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end();
      return true;
    }
    res.setHeader(
      "Content-Type",
      asset[1].endsWith(".wasm") ? "application/wasm" : "application/javascript"
    );
    const stream = fs.createReadStream(path.join(assetsPath, asset[1]));
    stream.on("error", () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end();
    });
    stream.pipe(res);
    return true;
  }
  if (pathname === "/audio-sample-create" || pathname === "/audio-sample-cancel") {
    if (
      req.method !== "POST" ||
      String(req.headers["content-type"] || "").split(";")[0] !== "application/json"
    ) {
      res.statusCode = 405;
      res.end();
      return true;
    }
    let size = 0,
      failed = false,
      body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (failed) return;
      size += Buffer.byteLength(chunk, "utf8");
      if (size > 32768) {
        failed = true;
        res.statusCode = 413;
        res.end();
        return;
      }
      body += chunk;
    });
    req.on("error", () => {
      if (failed) return;
      failed = true;
      res.end();
    });
    req.on("end", () => {
      if (failed) return;
      let options;
      try {
        options = JSON.parse(body);
        if (!options || typeof options !== "object" || Array.isArray(options)) throw Error();
      } catch (_) {
        res.statusCode = 400;
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (pathname === "/audio-sample-cancel") {
        cancel(options.requestId);
        res.end('{"returnValue":true}');
        return;
      }
      res.on("close", () => {
        if (!res.finished) cancel(options.requestId);
      });
      create(options).then(
        (result) => res.end(JSON.stringify(result)),
        () => {
          if (!res.headersSent) res.statusCode = 422;
          res.end('{"returnValue":false,"errorCode":"AUDIO_SAMPLE_UNAVAILABLE"}');
        }
      );
    });
    return true;
  }
  const slot = ready;
  if (!local || req.method !== "GET" || !slot || pathname !== "/audio-samples/" + slot.token) {
    res.statusCode = 404;
    res.end();
    return true;
  }
  ready = null;
  clearTimeout(slot.timer);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", slot.input.length);
  res.end(slot.input);
  return true;
}
module.exports = {
  create,
  cancel,
  handle,
  configureAssets(directory) {
    assetsPath = directory;
  }
};
