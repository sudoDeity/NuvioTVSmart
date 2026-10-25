/* global Buffer, module, require */
"use strict";

var http = require("http");
var urlModule = require("url");
var parser = require("./tx3g-subtitle-parser.cjs");
var audioSamples = require("../../shared/audio-sync/audioSamples.cjs");
audioSamples.configureAssets(require("path").join(__dirname, "audio-sync"));
var embeddedTextParser = null;

// Keep this outside the media runtime's 2710-2714 candidate range so a media
// server recovery cannot collide with the subtitle extractor.
var DEFAULT_PORT = 2715;
var service = null;

function getEmbeddedTextParser() {
  if (!embeddedTextParser) {
    // Keep zlib and the Matroska parser out of the EngineFS startup path. The
    // parser is loaded only after a Tizen embedded text fallback is selected.
    embeddedTextParser = require("./embedded-text-subtitle-parser.cjs");
  }
  return embeddedTextParser;
}

function sendJson(response, statusCode, payload) {
  var body = JSON.stringify(payload || {});
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function parseNumber(value, fallback) {
  var number = Number(value);
  return isFinite(number) ? number : fallback;
}

function isAllowedLocalOrigin(request) {
  var origin = String(request.headers.origin || "");
  if (!origin || origin === "null") return true;
  try {
    var parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch (_) {
    return false;
  }
}

function handleRequest(request, response) {
  if (audioSamples.handle(request, response)) return;
  var parsed = urlModule.parse(request.url || "/", true);
  if (!isAllowedLocalOrigin(request) &&
      (parsed.pathname === "/subtitle-sync" || parsed.pathname === "/subtitle-sync-cancel")) {
    sendJson(response, 403, { returnValue: false, errorCode: "FORBIDDEN_ORIGIN" });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (parsed.pathname === "/settings") {
    sendJson(response, 200, { tx3g: true, embeddedText: true, service: "nuvio-tx3g" });
    return;
  }

  if (
    (parsed.pathname !== "/tx3g" && parsed.pathname !== "/embedded-text" &&
      parsed.pathname !== "/subtitle-sync" && parsed.pathname !== "/subtitle-sync-cancel") ||
    (parsed.pathname !== "/subtitle-sync" && request.method !== "GET")
  ) {
    sendJson(response, 404, { returnValue: false, errorCode: "NOT_FOUND" });
    return;
  }

  if (parsed.pathname === "/subtitle-sync" || parsed.pathname === "/subtitle-sync-cancel") {
    if (parsed.pathname === "/subtitle-sync-cancel") {
      getEmbeddedTextParser().cancelSubtitleSyncTimeline(String(parsed.query.requestId || ""));
      sendJson(response, 200, { returnValue: true });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { returnValue: false, errorCode: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
      sendJson(response, 415, { returnValue: false, errorCode: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }
    var body = "";
    var rejected = false;
    request.on("data", function (chunk) {
      if (rejected) return;
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > 32768) {
        rejected = true;
        sendJson(response, 413, { returnValue: false, errorCode: "REQUEST_TOO_LARGE" });
      }
    });
    request.on("end", function () {
      if (rejected) return;
      var payload;
      try {
        payload = JSON.parse(body);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("body");
      } catch (_) {
        sendJson(response, 400, { returnValue: false, errorCode: "INVALID_JSON" });
        return;
      }
      var syncRequestId = String(payload.requestId || "");
      response.on("close", function () {
        getEmbeddedTextParser().cancelSubtitleSyncTimeline(syncRequestId);
      });
      getEmbeddedTextParser().getSubtitleSyncTimeline({
        url: String(payload.url || ""), requestId: syncRequestId, headers: payload.headers || {}
      }).then(function (result) {
        if (!response.destroyed) sendJson(response, 200, result);
      }).catch(function (error) {
        if (!response.destroyed) sendJson(response, 422, {
          returnValue: false, errorCode: String(error.code || "SYNC_FAILED")
        });
      });
    });
    request.on("error", function () {
      if (!rejected) {
        rejected = true;
        if (!response.headersSent) sendJson(response, 400, { returnValue: false, errorCode: "INVALID_REQUEST" });
      }
    });
    return;
  }

  var isEmbeddedTextRequest = parsed.pathname === "/embedded-text";
  var sourceUrl = String(parsed.query.url || "").trim();
  var trackNumber = parseNumber(parsed.query.trackNumber, 0);
  var trackOrdinal = parseNumber(parsed.query.trackOrdinal, -1);
  var startSeconds = Math.max(0, parseNumber(parsed.query.startSeconds, 0));
  var endSeconds = parseNumber(parsed.query.endSeconds, startSeconds + 120);
  if (
    !/^https?:\/\//i.test(sourceUrl) ||
    (isEmbeddedTextRequest
      ? !isFinite(trackOrdinal) || trackOrdinal < 0
      : !isFinite(trackNumber) || trackNumber <= 0)
  ) {
    sendJson(response, 400, {
      returnValue: false,
      errorCode: "INVALID_REQUEST",
      errorText: isEmbeddedTextRequest
        ? "Embedded text source URL and trackOrdinal are required"
        : "TX3G source URL and trackNumber are required"
    });
    return;
  }

  var extraction = Promise.resolve().then(function () {
    return isEmbeddedTextRequest
      ? getEmbeddedTextParser().getEmbeddedTextSubtitleWindow({
          url: sourceUrl,
          trackOrdinal: trackOrdinal,
          startSeconds: startSeconds,
          endSeconds: endSeconds
        })
      : parser.extractTx3gWindow({
          url: sourceUrl,
          trackNumber: trackNumber,
          startSeconds: startSeconds,
          endSeconds: endSeconds
        });
  });

  extraction
    .then(function (payload) {
      sendJson(response, 200, payload);
    })
    .catch(function (error) {
      var errorCode = String(
        (error && error.code) || (isEmbeddedTextRequest ? "EMBEDDED_TEXT_PARSE_FAILED" : "TX3G_PARSE_FAILED")
      );
      console.warn(
        isEmbeddedTextRequest ? "[Nuvio embedded text] extraction failed" : "[Nuvio TX3G] extraction failed",
        errorCode,
        error && error.message ? error.message : error
      );
      sendJson(response, 422, {
        returnValue: false,
        errorCode: errorCode,
        errorText: String(
          error && error.message
            ? error.message
            : error || (isEmbeddedTextRequest ? "Embedded text extraction failed" : "TX3G extraction failed")
        )
      });
    });
}

function start(port) {
  if (service) {
    return service;
  }
  service = http.createServer(handleRequest);
  service.on("error", function (error) {
    console.warn("[Nuvio TX3G] local subtitle server unavailable", error && error.message ? error.message : error);
  });
  service.listen(Number(port || process.env.TX3G_PORT || DEFAULT_PORT), "127.0.0.1");
  return service;
}

function stop() {
  if (!service) {
    return;
  }
  try {
    service.close();
  } catch (_) {}
  service = null;
}

module.exports = {
  start: start,
  stop: stop,
  handleRequest: handleRequest
};
