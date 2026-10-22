// One bounded operation per attachment. UI/lifecycle checks remain with the caller.
export class AutomaticSubtitleSyncSession {
  constructor({ requestReference, createWorker, enabled, onResult, onStatus = () => {} }) {
    this.requestReference = requestReference;
    this.createWorker = createWorker;
    this.enabled = enabled;
    this.onResult = onResult;
    this.onStatus = onStatus;
    this.generation = 0;
    this.reference = null;
  }

  cancel({ clearCache = false } = {}) {
    this.generation++;
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = null;
    this.pending?.cancel();
    this.pending = null;
    if (clearCache) this.reference = null;
  }

  async run({ url, headers, cues, isCurrent }) {
    this.cancel();
    if (!this.enabled() || !isCurrent()) return;
    if (!Array.isArray(cues) || cues.length < 30 || cues.length > 6000) {
      this.onStatus("unavailable");
      return;
    }
    const generation = this.generation;
    const current = () => generation === this.generation && this.enabled() && isCurrent();
    const finish = (result = null) => {
      if (generation !== this.generation) return;
      const active = current();
      this.cancel();
      if (!active) return;
      let applied = false;
      try {
        if (result) applied = this.onResult(result) !== false;
      } finally {
        if (this.enabled() && isCurrent()) this.onStatus(applied ? "synchronized" : "unavailable");
      }
    };
    this.onStatus("checking");
    // Bounds include service startup; worker processing has its own shorter deadline.
    this.timeout = setTimeout(() => finish(), 16000);
    const key = JSON.stringify([url, headers]);
    try {
      let tracks;
      if (this.reference?.key === key && Date.now() < this.reference.expiresAt)
        tracks = this.reference.tracks;
      else {
        this.pending = this.requestReference({
          url,
          headers,
          requestId: `sync-${Date.now()}-${generation}-${Math.random().toString(36).slice(2, 10)}`
        });
        tracks = await this.pending.promise;
        if (!current()) return;
        this.reference = { key, tracks, expiresAt: Date.now() + (tracks ? 600000 : 120000) };
      }
      if (!current()) return;
      if (!tracks?.length) {
        finish();
        return;
      }
      this.worker = this.createWorker();
      const worker = this.worker;
      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => finish(), 4500);
      worker.onmessage = ({ data }) => {
        finish(data?.result);
      };
      worker.onerror = () => {
        finish();
      };
      // Only times cross the worker boundary; display text/layout stay untouched.
      worker.postMessage({ cues: cues.map((c) => ({ start: c.start, end: c.end })), tracks });
    } catch (_) {
      // Unsupported sources and service failures should not be retried for every selection.
      if (current()) this.reference = { key, tracks: null, expiresAt: Date.now() + 120000 };
      finish();
      // Optional analysis failure leaves the currently rendered subtitle alone.
    } finally {
      if (generation === this.generation && !this.worker) {
        clearTimeout(this.timeout);
        this.pending = null;
      }
    }
  }
}
