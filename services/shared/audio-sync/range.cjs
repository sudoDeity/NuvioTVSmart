const http = require("http"),
  https = require("https"),
  URL = require("url").URL;
function requestRange(source, start, end, maxBytes, redirects, context) {
  return new Promise((resolve, reject) => {
    if (context.cancelled || Date.now() >= context.deadline || ++context.requestCount > 1024)
      return reject(Error("AUDIO_SAMPLE_BUDGET"));
    const url = new URL(source);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      return reject(Error("AUDIO_SAMPLE_URL"));
    const secure = url.protocol === "https:",
      transport = secure ? https : http,
      agentKey = secure ? "httpsAgent" : "httpAgent";
    if (!context[agentKey])
      context[agentKey] = new transport.Agent({ keepAlive: true, maxSockets: 1 });
    const req = transport.request(
      url,
      {
        agent: context[agentKey],
        headers: Object.assign({}, url.origin === context.origin ? context.headers : {}, {
          Range: `bytes=${start}-${end}`,
          "Accept-Encoding": "identity"
        })
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy();
          context.requests.delete(req);
          if (redirects >= 4) return reject(Error("AUDIO_SAMPLE_REDIRECT"));
          let next;
          try {
            next = new URL(res.headers.location, url).href;
          } catch (_) {
            return reject(Error("AUDIO_SAMPLE_URL"));
          }
          return requestRange(next, start, end, maxBytes, redirects + 1, context).then(
            resolve,
            reject
          );
        }
        const range = String(res.headers["content-range"] || "").match(
          /^bytes (\d+)-(\d+)\/(\d+)$/i
        );
        const total = Number(range && range[3]);
        if (
          res.statusCode !== 206 ||
          !range ||
          Number(range[1]) !== start ||
          Number(range[2]) !== Math.min(end, total - 1) ||
          !Number.isSafeInteger(total) ||
          total <= start ||
          (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity")
        ) {
          res.destroy();
          context.requests.delete(req);
          return reject(Error("AUDIO_SAMPLE_RANGE"));
        }
        let size = 0;
        const parts = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          context.bytes += chunk.length;
          if (size > maxBytes || context.bytes > context.maxBytes)
            return req.destroy(Error("AUDIO_SAMPLE_BUDGET"));
          parts.push(chunk);
        });
        res.on("error", reject);
        res.on("aborted", () => reject(Error("AUDIO_SAMPLE_RANGE")));
        res.on("end", () => {
          context.requests.delete(req);
          if (size !== Number(range[2]) - start + 1 || context.cancelled)
            return reject(Error("AUDIO_SAMPLE_RANGE"));
          resolve({ buffer: Buffer.concat(parts, size), totalSize: total });
        });
      }
    );
    context.requests.add(req);
    req.on("error", (error) => {
      context.requests.delete(req);
      reject(error);
    });
    req.setTimeout(Math.min(8000, Math.max(1, context.deadline - Date.now())), () =>
      req.destroy(Error("AUDIO_SAMPLE_TIMEOUT"))
    );
    req.end();
  });
}
module.exports = { requestRange };
