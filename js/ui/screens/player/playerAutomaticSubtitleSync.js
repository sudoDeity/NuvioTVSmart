import { AutomaticSubtitleSyncSession } from "../../../core/player/automaticSubtitleSyncSession.js";
import { retimeSubtitleCues } from "../../../core/player/automaticSubtitleSyncMatcher.js";
import { createSubtitleSyncReferenceRequest } from "../../../data/repository/subtitleSyncRepository.js";
import { PlayerSettingsStore } from "../../../data/local/playerSettingsStore.js";
import { PlayerController } from "../../../core/player/playerController.js";

export const PlayerAutomaticSubtitleSyncMethods = {
  cancelAutomaticSubtitleSync(clearCache = false) {
    this.automaticSubtitleSyncSession?.cancel({ clearCache });
    this.automaticSubtitleSyncApplied = null;
    this.automaticSubtitleSyncStatus = null;
    this.refreshAutomaticSubtitleSyncStatusDisplay?.();
    if (clearCache) {
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
    return applied;
  },

  getAutomaticSubtitleSyncCueTimeMs(originalTimeMs) {
    const mapping = this.getAutomaticSubtitleSyncMapping();
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
    const onStatus = (status) => {
      if (!enabled() || !isCurrent()) return;
      this.automaticSubtitleSyncStatus = { status, subtitleId, selectionToken, mountToken, url };
      this.refreshAutomaticSubtitleSyncStatusDisplay?.();
      this.refreshSubtitleSynchronizationOverlay?.();
    };
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
  }
};
