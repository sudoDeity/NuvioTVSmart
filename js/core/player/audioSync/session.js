import { planAudioSpots } from "./planner.js";
import { dialogueCues } from "./timeline.js";
export class AudioSubtitleSyncSession {
  constructor({
    requestSample,
    createWorker,
    enabled,
    onStatus,
    onResult,
    onInvalidated = () => {},
    getPosition,
    getDuration,
    getSelection,
    sampling = "low",
    storage = null,
    loadCandidates = async () => [],
    initialMapping = null,
    canSample = () => true
  }) {
    Object.assign(this, {
      requestSample,
      createWorker,
      enabled,
      onStatus,
      onResult,
      onInvalidated,
      getPosition,
      getDuration,
      getSelection,
      sampling,
      storage,
      loadCandidates,
      initialMapping,
      canSample
    });
    this.generation = 0;
  }
  cancel() {
    this.generation++;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    clearInterval(this.healthWatchdog);
    this.sleepResolve?.();
    this.sleepResolve = null;
    this.pending?.cancel();
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    if (this.waiter) {
      this.waiter.reject(Error("Analysis cancelled"));
      this.waiter = null;
    }
  }
  exchange(message, transfer = []) {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.worker.postMessage(message, transfer);
    });
  }
  async run({ url, headers, cues, subtitleId, isCurrent }) {
    this.cancel();
    const generation = this.generation;
    let identity;
    try {
      identity = this.getSelection();
    } catch (_) {
      this.onStatus("unavailable");
      return;
    }
    if (!identity || dialogueCues(cues).length < 20) {
      this.onStatus("unavailable");
      return;
    }
    const key = JSON.stringify(identity);
    const current = () => {
      try {
        return (
          generation === this.generation &&
          this.enabled() &&
          isCurrent() &&
          JSON.stringify(this.getSelection()) === key
        );
      } catch (_) {
        return false;
      }
    };
    if (!current()) return;
    this.watchdog = setInterval(() => {
      if (!current()) {
        this.cancel();
        this.onInvalidated();
      }
    }, 500);
    try {
      this.worker = this.createWorker();
    } catch (_) {
      this.onStatus("unavailable");
      this.cancel();
      return;
    }
    this.worker.onmessage = ({ data }) => {
      if (!this.waiter || !current()) return;
      const waiter = this.waiter;
      this.waiter = null;
      if (data?.type === "error") waiter.reject(Error("Audio analysis unavailable"));
      else waiter.resolve(data);
    };
    this.worker.onerror = () => {
      this.waiter?.reject(Error("Audio worker failed"));
      this.waiter = null;
    };
    // A worker can fail or stop responding without firing onerror (e.g. device memory pressure).
    let lastProgress = Date.now(),
      mapping = null;
    this.healthWatchdog = setInterval(() => {
      if (Date.now() - lastProgress > 65000) {
        if (!mapping?.confirmed) this.onStatus("unavailable");
        this.cancel();
      }
    }, 1000);
    let budget = (this.sampling === "high" ? 150 : 75) * 1000000;
    let errors = 0,
      lastSample = -Infinity,
      initial = true;
    try {
      this.onStatus("checking");
      this.timer = setTimeout(() => {
        if (current()) this.onStatus("unavailable");
        this.cancel();
      }, 15000);
      const ready = await this.exchange({ type: "init", tracks: [{ id: subtitleId, cues }] });
      clearTimeout(this.timer);
      lastProgress = Date.now();
      if (!current() || ready.type !== "ready") return;
      const cacheKey = JSON.stringify([
        url,
        headers,
        key,
        subtitleId,
        ready.version,
        cues.map((c) => [c.start, c.end])
      ]);
      const remembered = this.initialMapping || this.storage?.get(cacheKey);
      if (remembered && current()) {
        mapping = remembered;
        this.onResult(remembered, subtitleId);
        this.onStatus("synchronized");
        await this.exchange({ type: "adopt", id: subtitleId, mapping: remembered });
      }
      const candidates = mapping?.confirmed ? [] : await this.loadCandidates();
      lastProgress = Date.now();
      if (!current()) return;
      if (candidates.length)
        await this.exchange({
          type: "addTracks",
          tracks: candidates.map((c) => ({ id: c.id, cues: c.cues }))
        });
      // Sampling is sequential: it cannot contend for multiple TV decoders or flood a media host.
      const spots =
        this.sampling === "off" || /^(?:https?:\/\/)?(?:localhost|127\.|\[::1\])/i.test(url)
          ? []
          : planAudioSpots(
              dialogueCues(cues),
              this.getDuration(),
              this.sampling === "high" ? 4 : 3
            );
      while (current()) {
        const playback = this.getPosition();
        if (!this.canSample()) {
          await new Promise((resolve) => {
            this.sleepResolve = resolve;
            this.timer = setTimeout(() => {
              this.sleepResolve = null;
              resolve();
            }, 1000);
          });
          lastProgress = Date.now();
          continue;
        }
        const ahead = initial && spots.length ? spots.shift() : null;
        if (ahead == null && Math.abs(playback - lastSample) < 20000) {
          await new Promise((resolve) => {
            this.sleepResolve = resolve;
            this.timer = setTimeout(() => {
              this.sleepResolve = null;
              resolve();
            }, 1000);
          });
          lastProgress = Date.now();
          continue;
        }
        if (!spots.length) initial = false;
        if (budget < 1024 * 1024) break;
        const positionMs = Math.max(0, ahead == null ? playback - 1000 : ahead);
        this.pending = this.requestSample({
          url,
          headers,
          selection: identity,
          positionMs,
          durationMs: 28000,
          maxBytes: Math.min(budget, 32 * 1024 * 1024),
          requestId: `audio-${Date.now()}-${generation}-${Math.random().toString(36).slice(2, 10)}`
        });
        let sample;
        try {
          sample = await this.pending.promise;
        } catch (_) {
          // Failed reads have an unknown cost; charge the full per-window allowance.
          budget -= Math.min(budget, 32 * 1024 * 1024);
          if (++errors >= 3) break;
          lastSample = playback;
          lastProgress = Date.now();
          continue;
        } finally {
          this.pending = null;
        }
        if (!current()) return;
        errors = 0;
        budget -= sample.networkBytes;
        lastSample = playback;
        lastProgress = Date.now();
        const result = await this.exchange(
          {
            type: "sample",
            pcm: sample.pcm,
            startMs: sample.startMs,
            playbackMs: playback,
            selectedId: subtitleId
          },
          [sample.pcm]
        );
        lastProgress = Date.now();
        if (!current()) return;
        const outcome = result.result;
        if (outcome?.mapping && this.onResult(outcome.mapping, outcome.id) !== false) {
          mapping = outcome.mapping;
          if (mapping.confirmed && current()) {
            if (outcome.id === subtitleId) this.storage?.set(cacheKey, mapping);
            this.onStatus("synchronized");
          }
        } else if (outcome?.status === "retracted" && mapping && !mapping.confirmed) {
          this.onResult(null);
          mapping = null;
          this.onStatus("checking");
        }
        // Stop speculative ahead reads after confirmation; continue validating around playback.
        if (mapping?.confirmed) {
          spots.length = 0;
          initial = false;
        }
      }
      if (current() && !mapping?.confirmed) {
        if (mapping) this.onResult(null);
        this.onStatus("unavailable");
      }
    } catch (_) {
      if (current() && !mapping?.confirmed) {
        if (mapping) this.onResult(null);
        this.onStatus("unavailable");
      }
    } finally {
      if (generation === this.generation) this.cancel();
    }
  }
}
