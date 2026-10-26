import { AutomaticSubtitleSyncSession } from "../../../core/player/automaticSubtitleSyncSession.js";
import { retimeSubtitleCues } from "../../../core/player/automaticSubtitleSyncMatcher.js";
import { createSubtitleSyncReferenceRequest } from "../../../data/repository/subtitleSyncRepository.js";
import { PlayerSettingsStore } from "../../../data/local/playerSettingsStore.js";
import { PlayerController } from "../../../core/player/playerController.js";
import { AudioSubtitleSyncSession } from "../../../core/player/audioSync/session.js";
import { audioMappingCache } from "../../../core/player/audioSync/cache.js";
import { resolveAudioSelection } from "../../../core/player/audioSync/selection.js";
import { retimeAudioCues, segmentAt, mediaTime } from "../../../core/player/audioSync/tracker.js";
import { releaseAudioSampleDecoder } from "../../../platform/audioSampleDecoder.js";
import { createAudioSampleRequest } from "../../../data/repository/audioSampleRepository.js";
import { ProfileManager } from "../../../core/profile/profileManager.js";
import { loadAudioCandidates } from "../../../core/player/audioSync/candidates.js";
import { dialogueCues } from "../../../core/player/audioSync/timeline.js";

export const PlayerAutomaticSubtitleSyncMethods = {
  cancelAutomaticSubtitleSync(clearCache = false) {
    this.audioSubtitleSyncSession?.cancel();
    this.audioSubtitleSyncSession = null;
    this.automaticSubtitleSyncSession?.cancel({ clearCache });
    this.automaticSubtitleSyncApplied = null;
    this.automaticSubtitleSyncStatus = null;
    this.refreshAutomaticSubtitleSyncStatusDisplay?.();
    if (clearCache) {
      this.pendingAudioSyncCandidate = null;
      this.automaticSubtitleSyncSession = null;
      this.automaticSubtitleSyncOriginalCues = null;
    }
  },

  clearAutomaticSubtitleSyncMappingForManualAdjustment() {
    // At extreme FPS drift the residual needed to reach zero can exceed
    // the allowed manual delay range. Restore original cues before setting
    // the requested total offset rather than silently clipping Reset.
    const original = this.automaticSubtitleSyncOriginalCues;
    if (!this.getAutomaticSubtitleSyncMapping() ||
        !Array.isArray(original?.cues) ||
        original.subtitleId !== this.htmlSubtitleSelectedId ||
        original.selectionToken !== this.subtitleSelectionToken) return false;
    this.automaticSubtitleSyncSession?.cancel();
    this.audioSubtitleSyncSession?.cancel();
    this.automaticSubtitleSyncApplied = null;
    this.automaticSubtitleSyncStatus = null;
    this.htmlSubtitleCues = original.cues;
    this.renderHtmlSubtitleOverlayAtCurrentTime();
    this.scheduleHtmlSubtitleOverlayRender();
    this.refreshAutomaticSubtitleSyncDisplay?.();
    return true;
  },

  getAutomaticSubtitleSyncStatus() {
    if (
      PlayerSettingsStore.get().subtitleStyle?.automaticSync !== true ||
      !this.selectedAddonSubtitleId
    )
      return null;
    const state = this.automaticSubtitleSyncStatus;
    if (
      state?.subtitleId === this.selectedAddonSubtitleId &&
      state.selectionToken === this.subtitleSelectionToken &&
      state.mountToken === this.playerMountToken &&
      state.url === this.getTrackProbeUrl()
    )
      return state.status;
    // Selected add-on formats/paths without an analysis cannot claim a match.
    return "unavailable";
  },

  getAutomaticSubtitleSyncMapping() {
    const applied = this.automaticSubtitleSyncApplied;
    if (
      !applied ||
      PlayerSettingsStore.get().subtitleStyle?.automaticSync !== true ||
      applied.subtitleId !== this.selectedAddonSubtitleId ||
      applied.subtitleId !== this.htmlSubtitleSelectedId ||
      applied.selectionToken !== this.subtitleSelectionToken ||
      applied.mountToken !== this.playerMountToken ||
      applied.url !== this.getTrackProbeUrl()
    )
      return null;
    if (applied.audioMapping) {
      if (PlayerSettingsStore.get().subtitleStyle?.audioSync === false ||
          applied.audioKey !== JSON.stringify(this.getAudioSubtitleSyncSelection())) return null;
      const segment = segmentAt(applied.audioMapping, Number(this.getPlaybackCurrentSeconds?.() || 0) * 1000);
      return { ...applied, scale: segment.scale, offset: segment.shiftMs / 1000 };
    }
    return applied;
  },

  getAutomaticSubtitleSyncCueTimeMs(originalTimeMs) {
    const mapping = this.getAutomaticSubtitleSyncMapping();
    if (mapping?.audioMapping) return mediaTime(originalTimeMs, mapping.audioMapping.segments) ?? originalTimeMs;
    return mapping ? originalTimeMs * mapping.scale + mapping.offset * 1000 : originalTimeMs;
  },

  getAutomaticSubtitleSyncDelayMs() {
    const applied = this.getAutomaticSubtitleSyncMapping();
    if (!applied) return null;
    const current = Number(this.getPlaybackCurrentSeconds?.() || 0);
    if (!Number.isFinite(current)) return null;
    // Display the delay at the current VIDEO position. Invert the affine
    // transform to find the corresponding original subtitle timestamp.
    return Math.round((current - (current - applied.offset) / applied.scale) * 1000);
  },

  getSubtitleSynchronizationDelayMs() {
    const manualMs = Number(this.subtitleDelayMs || 0);
    const mapping = this.getAutomaticSubtitleSyncMapping();
    const current = Number(this.getPlaybackCurrentSeconds?.() || 0);
    if (!mapping || !Number.isFinite(current)) return manualMs;
    // One displayed delay for the complete transform: video = scale * original
    // + offset + manual. Inverting it also accounts for rate correction.
    return Math.round(
      (current - (current - mapping.offset - manualMs / 1000) / mapping.scale) * 1000
    );
  },

  getSubtitleSynchronizationManualDelayMs(totalMs) {
    const mapping = this.getAutomaticSubtitleSyncMapping();
    const current = Number(this.getPlaybackCurrentSeconds?.() || 0);
    if (!mapping || !Number.isFinite(current)) return totalMs;
    // A change to the shared slider adjusts the existing transform rather than
    // adding its automatic delay a second time or losing its rate correction.
    return Math.round(
      mapping.scale * totalMs - ((mapping.scale - 1) * current + mapping.offset) * 1000
    );
  },

  setAutomaticSubtitleSyncEnabled(enabled) {
    const currentDelayMs = this.getSubtitleSynchronizationDelayMs();
    const settings = PlayerSettingsStore.get();
    PlayerSettingsStore.set({
      subtitleStyle: { ...settings.subtitleStyle, automaticSync: enabled }
    });
    if (enabled) this.retryAutomaticSubtitleSync(false);
    else {
      this.updateAutomaticSubtitleSyncSetting();
      // Manual mode takes over the current effective offset without a jump.
      this.setSubtitleDelayValue(currentDelayMs);
    }
    this.renderSubtitleDelayOverlay?.();
    this.renderSubtitleDialog?.();
  },

  retryAutomaticSubtitleSync(clearCache = true) {
    const subtitle = this.getSelectedAddonSubtitle?.();
    if (
      !subtitle ||
      this.isAssAddonSubtitleActive?.() ||
      this.htmlSubtitleSelectedId !== this.selectedAddonSubtitleId
    )
      return false;
    const original = this.automaticSubtitleSyncOriginalCues;
    const cues =
      original?.subtitleId === this.selectedAddonSubtitleId &&
      original.selectionToken === this.subtitleSelectionToken
        ? original.cues
        : this.htmlSubtitleCues;
    if (!Array.isArray(cues) || !cues.length) return false;
    // Keep the current transform and slider value while checking. A failed
    // retry must not remove a working correction or expose only its residual.
    this.automaticSubtitleSyncSession?.cancel();
    if (clearCache && this.automaticSubtitleSyncSession)
      this.automaticSubtitleSyncSession.reference = null;
    this.startAutomaticSubtitleSync(subtitle, cues, this.subtitleSelectionToken, {
      replaceManualAdjustment: true
    });
    return true;
  },

  updateAutomaticSubtitleSyncSetting() {
    if (this.audioSubtitleSyncSession && PlayerSettingsStore.get().subtitleStyle?.audioSync === false) {
      this.audioSubtitleSyncSession.cancel(); this.audioSubtitleSyncSession = null;
      if (this.automaticSubtitleSyncApplied?.audioMapping) {
        this.automaticSubtitleSyncApplied = null;
        this.htmlSubtitleCues = this.automaticSubtitleSyncOriginalCues?.cues || this.htmlSubtitleCues;
        this.automaticSubtitleSyncStatus = null;
        this.renderHtmlSubtitleOverlayAtCurrentTime(); this.scheduleHtmlSubtitleOverlayRender();
        this.refreshAutomaticSubtitleSyncStatusDisplay?.(); this.refreshSubtitleSynchronizationOverlay?.();
      }
    }
    if (
      !this.automaticSubtitleSyncSession ||
      PlayerSettingsStore.get().subtitleStyle?.automaticSync === true
    )
      return;
    const original = this.automaticSubtitleSyncOriginalCues;
    this.cancelAutomaticSubtitleSync(true);
    if (
      original &&
      original.subtitleId === this.htmlSubtitleSelectedId &&
      original.selectionToken === this.subtitleSelectionToken
    ) {
      this.htmlSubtitleCues = original.cues;
      this.renderHtmlSubtitleOverlayAtCurrentTime();
      this.scheduleHtmlSubtitleOverlayRender();
    }
    this.automaticSubtitleSyncOriginalCues = null;
    this.automaticSubtitleSyncSession = null;
    if (this.subtitleDelayOverlayVisible) this.renderSubtitleDelayOverlay?.();
    if (this.subtitleDialogVisible) this.renderSubtitleDialog?.();
  },

  startAutomaticSubtitleSync(
    subtitle,
    cues,
    selectionToken,
    { replaceManualAdjustment = false } = {}
  ) {
    const enabled = () => PlayerSettingsStore.get().subtitleStyle?.automaticSync === true;
    if (!enabled()) return;
    const url = this.getTrackProbeUrl();
    const subtitleId = subtitle.id || subtitle.url;
    const mountToken = this.playerMountToken;
    const isCurrent = () =>
      this.playerMountToken === mountToken &&
      this.subtitleSelectionToken === selectionToken &&
      this.getTrackProbeUrl() === url &&
      this.selectedAddonSubtitleId === subtitleId &&
      this.htmlSubtitleSelectedId === subtitleId;
    if (!isCurrent()) return;
    this.audioSubtitleSyncSession?.cancel(); this.audioSubtitleSyncSession = null;
    const onStatus = (status) => {
      if (!enabled() || !isCurrent()) return;
      if (status === "unavailable" && this.startAudioSubtitleSync({ url, subtitleId, cues, selectionToken, mountToken, isCurrent, replaceManualAdjustment })) return;
      this.automaticSubtitleSyncStatus = { status, subtitleId, selectionToken, mountToken, url };
      this.refreshAutomaticSubtitleSyncStatusDisplay?.();
      this.refreshSubtitleSynchronizationOverlay?.();
    };
    const candidate = this.pendingAudioSyncCandidate;
    this.pendingAudioSyncCandidate = null;
    if (candidate?.subtitleId === subtitleId && candidate.selectionToken === selectionToken && candidate.url === url && candidate.audioKey === JSON.stringify(this.getAudioSubtitleSyncSelection())) {
      const retimed = retimeAudioCues(cues, candidate.mapping);
      if (retimed?.length) {
        this.htmlSubtitleCues = retimed;
        this.automaticSubtitleSyncApplied = { audioMapping: candidate.mapping, audioKey: candidate.audioKey, subtitleId, selectionToken, mountToken, url };
        this.renderHtmlSubtitleOverlayAtCurrentTime(); this.scheduleHtmlSubtitleOverlayRender();
      }
    }
    if (
      typeof Worker !== "function" ||
      this.isCurrentSourceAdaptiveManifest?.() ||
      !/^https?:\/\//i.test(url)
    ) {
      onStatus("unavailable");
      return;
    }
    this.automaticSubtitleSyncOriginalCues = { subtitleId, cues, selectionToken };
    this.automaticSubtitleSyncSession?.cancel();
    // Keep the per-stream cache when starting a new subtitle attachment.
    const previousReference = this.automaticSubtitleSyncSession?.reference;
    this.automaticSubtitleSyncSession = new AutomaticSubtitleSyncSession({
      enabled,
      requestReference: createSubtitleSyncReferenceRequest,
      createWorker: () => new Worker("assets/runtime/subtitle-sync-worker.js"),
      onStatus,
      onResult: (mapping) => {
        if (!enabled() || !isCurrent()) return false;
        const retimed = retimeSubtitleCues(cues, mapping);
        if (!retimed?.length) return false;
        // Original cue objects are never mutated. An explicit Match replaces
        // the shared slider's adjustment only after accepting a new mapping.
        this.htmlSubtitleCues = retimed;
        this.automaticSubtitleSyncApplied = {
          scale: mapping.scale,
          offset: mapping.offset,
          subtitleId,
          selectionToken,
          mountToken,
          url
        };
        if (replaceManualAdjustment) this.setSubtitleDelayValue(0);
        this.renderHtmlSubtitleOverlayAtCurrentTime();
        this.scheduleHtmlSubtitleOverlayRender();
        if (this.subtitleDelayOverlayVisible) this.renderSubtitleDelayOverlay?.();
        if (this.subtitleDialogVisible) this.renderSubtitleDialog?.();
        return true;
      }
    });
    this.automaticSubtitleSyncSession.reference = previousReference;
    void this.automaticSubtitleSyncSession.run({
      url,
      headers: PlayerController.currentPlaybackHeaders || {},
      cues,
      isCurrent
    });
  },
  getAudioSubtitleSyncSelection() {
    return resolveAudioSelection(this.getAudioEntries?.() || [], PlayerController.getAvPlayAudioTracks?.() || []);
  },

  startAudioSubtitleSync({ url, subtitleId, cues, selectionToken, mountToken, isCurrent, replaceManualAdjustment }) {
    const enabled = () => PlayerSettingsStore.get().subtitleStyle?.automaticSync === true && PlayerSettingsStore.get().subtitleStyle?.audioSync !== false;
    const selection = this.getAudioSubtitleSyncSelection();
    if (!enabled() || !selection || !isCurrent() || this.audioSubtitleSyncSession || this.isCurrentSourceAdaptiveManifest?.()) return false;
    const audioKey = JSON.stringify(selection);
    const status = value => {
      if (!enabled() || !isCurrent()) return;
      this.automaticSubtitleSyncStatus = { status: value, subtitleId, selectionToken, mountToken, url };
      this.refreshAutomaticSubtitleSyncStatusDisplay?.(); this.refreshSubtitleSynchronizationOverlay?.();
    };
    let replaceManual = replaceManualAdjustment;
    const candidates = new Map();
    this.audioSubtitleSyncSession = new AudioSubtitleSyncSession({
      requestSample: createAudioSampleRequest,
      releaseDecoder: releaseAudioSampleDecoder,
      createWorker: () => new Worker("assets/runtime/audio-sync-worker.js"),
      enabled, onStatus: status,
      sampling: PlayerSettingsStore.get().subtitleStyle?.audioSyncSampling || "low",
      storage: audioMappingCache(ProfileManager.getActiveProfileId()),
      initialMapping: this.automaticSubtitleSyncApplied?.audioMapping?.confirmed ? this.automaticSubtitleSyncApplied.audioMapping : null,
      loadCandidates: async () => {
        const selected = this.getSelectedAddonSubtitle?.();
        if (!selected || !this.fetchSubtitleRawBody || !this.parseSubtitleCues) return [];
        const loaded = await loadAudioCandidates(this.subtitles || [], selected, async sub => {
          const raw = await this.fetchSubtitleRawBody(sub.url, { timeoutMs: 5000, languageHint: sub.lang || sub.language || "", subtitleHeaders: sub.headers || {} });
          return raw?.body && raw.body.length <= 4 * 1024 * 1024 && !/^\s*\[Script Info\]/i.test(raw.body) ? this.parseSubtitleCues(raw.body) : [];
        }, () => enabled() && isCurrent());
        for (const c of loaded) candidates.set(c.id, { id: c.id, subtitle: c.subtitle });
        return loaded.map(c => ({ id: c.id, cues: dialogueCues(c.cues) }));
      },
      getPosition: () => Number(this.getPlaybackCurrentSeconds?.() || 0) * 1000,
      getDuration: () => Number(this.getPlaybackDurationSeconds?.() || 0) * 1000,
      getSelection: () => this.getAudioSubtitleSyncSelection(),
      canSample: () => {
        if (PlayerController.avplayBufferingStartedAt) return false;
        if (!PlayerController.isUsingAvPlay?.() && PlayerController.video?.paused) return false;
        const buffered = this.getPlaybackBufferedSeconds?.();
        return buffered == null || buffered - Number(this.getPlaybackCurrentSeconds?.() || 0) >= 5;
      },
      onInvalidated: () => {
        if (!isCurrent()) return;
        if (this.automaticSubtitleSyncApplied?.audioMapping) {
          this.automaticSubtitleSyncApplied = null; this.htmlSubtitleCues = cues;
          this.renderHtmlSubtitleOverlayAtCurrentTime(); this.scheduleHtmlSubtitleOverlayRender();
        }
        this.audioSubtitleSyncSession = null;
        if (enabled()) this.retryAutomaticSubtitleSync(false);
      },
      onResult: (mapping, candidateId = subtitleId) => {
        if (!enabled() || !isCurrent() || audioKey !== JSON.stringify(this.getAudioSubtitleSyncSelection())) return false;
        if (candidateId !== subtitleId) {
          const chosen = candidates.get(candidateId);
          if (!mapping?.confirmed || !chosen || !this.applySubtitleEntry) return false;
          this.pendingAudioSyncCandidate = { subtitleId: candidateId, selectionToken: selectionToken + 1, mapping, audioKey, url };
          this.applySubtitleEntry({ fallbackAddonSubtitle: true, track: chosen.subtitle, subtitleId: candidateId,
            subtitleIndex: (this.subtitles || []).indexOf(chosen.subtitle) });
          return true;
        }
        if (!mapping) {
          if (this.automaticSubtitleSyncApplied?.audioMapping && !this.automaticSubtitleSyncApplied.audioMapping.confirmed) {
            this.htmlSubtitleCues = cues; this.automaticSubtitleSyncApplied = null;
            this.renderHtmlSubtitleOverlayAtCurrentTime(); this.scheduleHtmlSubtitleOverlayRender();
          }
          return true;
        }
        const retimed = retimeAudioCues(cues, mapping);
        if (!retimed?.length) return false;
        const current = segmentAt(mapping, Number(this.getPlaybackCurrentSeconds?.() || 0) * 1000);
        this.htmlSubtitleCues = retimed;
        this.automaticSubtitleSyncApplied = { scale: current.scale, offset: current.shiftMs / 1000,
          audioMapping: mapping, audioKey, subtitleId, selectionToken, mountToken, url };
        if (replaceManual) { this.setSubtitleDelayValue(0); replaceManual = false; }
        this.renderHtmlSubtitleOverlayAtCurrentTime(); this.scheduleHtmlSubtitleOverlayRender();
        this.refreshSubtitleSynchronizationOverlay?.();
        return true;
      }
    });
    void this.audioSubtitleSyncSession.run({ url, headers: PlayerController.currentPlaybackHeaders || {}, cues, subtitleId, isCurrent });
    return true;
  }
};
