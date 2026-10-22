/* eslint-disable no-unused-vars */
import * as internals from "./playerScreenContext.js";
import { PlayerSettingsStore } from "../../../data/local/playerSettingsStore.js";

export function createPlayerScreenMethods57() {
  const {
    Environment,
    SUBTITLE_DELAY_MAX_MS,
    SUBTITLE_DELAY_MIN_MS,
    SUBTITLE_DELAY_STEP_MS,
    isSelectKeyCode,
    t,
    clamp,
    escapeHtml,
    formatSubtitleDelay
  } = internals;

  const icon = (paths, className = "") =>
    `<svg class="player-subtitle-sync-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  const alignIcon = icon('<path d="M4 7h16M4 12h10M4 17h7M18 14v7m-3-3 3 3 3-3"/>');
  const resetIcon = icon('<path d="M3 4v6h6M4 10a8 8 0 1 1 1 8"/>');
  const statusIcon = icon(
    '<g class="sync-state-success"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></g><g class="sync-state-checking"><path d="M21 12a9 9 0 1 1-9-9"/></g><g class="sync-state-unavailable"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></g><g class="sync-state-off"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></g>'
  );

  const formatOffset = (ms) => {
    const value = Math.round(Number(ms) || 0);
    const sign = value >= 0 ? "+" : "−";
    const magnitude = Math.abs(value);
    return magnitude < 1000
      ? sign + magnitude + " ms"
      : sign + (magnitude / 1000).toFixed(magnitude % 1000 === 0 ? 0 : 2) + " s";
  };

  return {
    getSubtitleSyncSliderRange(offsetMs = this.getSubtitleSynchronizationDelayMs()) {
      const magnitude = Math.abs(Number(offsetMs) || 0);
      const halfSpan = magnitude <= 5000 ? 5000 : magnitude <= 30000 ? 30000
        : magnitude <= 180000 ? 180000 : Math.ceil((magnitude + 10000) / 10000) * 10000;
      return { minimum: -halfSpan, maximum: halfSpan };
    },
    setSubtitleSyncOffsetFromPointer(event, slider) {
      const model = this.getSubtitleSynchronizationModel();
      if (!model.manual || !slider || !Number.isFinite(event?.clientX)) return false;
      const rect = slider.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0)) return false;
      const { minimum, maximum } = this.getSubtitleSyncSliderRange(model.delayMs);
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const value = Math.round((minimum + ratio * (maximum - minimum)) / 100) * 100;
      this.setSubtitleSynchronizationDelayValue(value, { showOverlay: true });
      return true;
    },
    getSubtitleSynchronizationModel() {
      const enabled = PlayerSettingsStore.get().subtitleStyle?.automaticSync === true;
      const subtitle = this.getSelectedAddonSubtitle?.();
      const status = this.getAutomaticSubtitleSyncStatus?.();
      const delayMs = this.getSubtitleSynchronizationDelayMs();
      // The final automatic mapping must be known before a manual line can
      // determine an additional delay; a later result would otherwise add it twice.
      const manual = !enabled || !subtitle || status === "unavailable";
      const showResult = manual;
      const canAlign = Boolean(manual && subtitle);
      const statusLabel = !enabled
        ? t("subtitle_sync_disabled", {}, "Automatic matching is off")
        : !subtitle
          ? t("subtitle_sync_select_addon", {}, "Select an add-on subtitle to use automatic matching.")
          : this.getAutomaticSubtitleSyncStatusLabel?.() || t("subtitle_automatic_sync_unavailable", {}, "No reliable match possible");
      return { enabled, status, delayMs, manual, showResult, canAlign, statusLabel };
    },
    renderSubtitleDelayOverlay() {
      const overlay = this.uiRefs?.subtitleDelayOverlay;
      if (!overlay) return;
      const visible = Boolean(this.subtitleDelayOverlayVisible);
      overlay.classList.toggle("hidden", !visible);
      overlay.setAttribute("aria-hidden", visible ? "false" : "true");
      if (!visible) {
        this.subtitleSyncPointerDragging = false;
        this.subtitleSyncPointerId = null;
        clearTimeout(this.subtitleSyncFailureNoticeTimer);
        this.subtitleSyncFailureNoticeTimer = null;
        this.subtitleSyncFailureNoticeKey = null;
        overlay.innerHTML = "";
        return;
      }
      if (!overlay.querySelector("[data-subtitle-sync-panel]")) {
overlay.innerHTML = `
          <div class="player-subtitle-delay-panel" data-subtitle-sync-panel role="dialog" aria-label="${escapeHtml(t("subtitle_sync_title", {}, "Synchronization"))}">
            <div class="player-subtitle-sync-header">
              <div class="player-subtitle-delay-title">${escapeHtml(t("subtitle_sync_title", {}, "Synchronization"))}</div>
              <button class="player-subtitle-sync-toggle focusable" type="button" role="switch" aria-checked="false" aria-label="${escapeHtml(t("subtitle_sync_auto_mode", {}, "Automatic"))}" data-subtitle-delay-focus="automatic" tabindex="-1">
                <span>${escapeHtml(t("subtitle_sync_auto_mode", {}, "Automatic"))}</span>
                <span class="player-subtitle-sync-failure-dot hidden" aria-hidden="true"></span>
                <span class="player-subtitle-sync-switch" aria-hidden="true"></span>
              </button>
            </div>
            <div class="player-subtitle-sync-status" data-subtitle-sync-state role="status" aria-live="polite" aria-atomic="true">
              <span class="player-subtitle-sync-status-group">${statusIcon}<span data-subtitle-sync-status></span></span>
              <span class="player-subtitle-sync-result" data-subtitle-sync-effective dir="ltr"></span>
            </div>
            <div class="player-subtitle-sync-adjustment" data-subtitle-sync-adjustment>
              <div data-subtitle-sync-manual>
                <div class="player-subtitle-sync-offset-row">
                  <span class="player-subtitle-sync-offset-label">${escapeHtml(t("subtitle_sync_offset", {}, "Subtitle offset"))}</span>
                  <span class="player-subtitle-delay-value" data-subtitle-sync-value dir="ltr"></span>
                </div>
                <div class="player-subtitle-delay-slider focusable" data-subtitle-delay-focus="slider" tabindex="-1" role="slider" aria-label="${escapeHtml(t("subtitle_sync_offset", {}, "Subtitle offset"))}">
                  <div class="player-subtitle-delay-slider-track"></div>
                  <div class="player-subtitle-delay-slider-fill"></div>
                  <div class="player-subtitle-delay-slider-ticks" aria-hidden="true"><span class="center"></span></div>
                  <div class="player-subtitle-delay-slider-thumb"></div>
                </div>
                <div class="player-subtitle-sync-directions" dir="ltr">
                  <span>${escapeHtml(t("subtitle_sync_earlier", {}, "Subtitles earlier"))}</span>
                  <span>${escapeHtml(t("subtitle_sync_later", {}, "Subtitles later"))}</span>
                </div>
                <div class="player-subtitle-delay-actions">
                  <button class="player-subtitle-delay-action focusable" type="button" data-subtitle-delay-focus="sync" tabindex="-1">${alignIcon}<span>${escapeHtml(t("subtitle_sync_align_short", {}, "Align line"))}</span></button>
                  <button class="player-subtitle-delay-action focusable" type="button" data-subtitle-delay-focus="reset" aria-label="${escapeHtml(t("subtitle_sync_reset", {}, "Reset"))}" title="${escapeHtml(t("subtitle_sync_reset", {}, "Reset"))}" tabindex="-1">${resetIcon}</button>
                </div>
              </div>
            </div>
          </div>`;
      }
      this.refreshSubtitleSynchronizationOverlay();
      this.syncSubtitleDelayOverlayFocusDom({ focus: false });
      // Magic Remote click works everywhere. Pointer capture additionally supports
      // dragging on webOS browsers that implement Pointer Events.
      if (overlay.addEventListener && this.subtitleSyncPointerBoundOverlay !== overlay) {
        this.subtitleSyncPointerBoundOverlay = overlay;
        overlay.addEventListener("pointerdown", (event) => {
          const slider = event.target?.closest?.('[data-subtitle-delay-focus="slider"]');
          if (!slider || !this.getSubtitleSynchronizationModel().manual) return;
          this.subtitleSyncPointerDragging = true;
          this.subtitleSyncPointerId = event.pointerId;
          slider.setPointerCapture?.(event.pointerId);
          this.subtitleDelayFocusTarget = "slider";
          this.syncSubtitleDelayOverlayFocusDom({ focus: false });
          this.setSubtitleSyncOffsetFromPointer(event, slider);
        });
        overlay.addEventListener("pointermove", (event) => {
          if (!this.subtitleSyncPointerDragging || event.pointerId !== this.subtitleSyncPointerId) return;
          const slider = overlay.querySelector('[data-subtitle-delay-focus="slider"]');
          this.setSubtitleSyncOffsetFromPointer(event, slider);
        });
        const stopDrag = (event) => {
          if (this.subtitleSyncPointerId !== event.pointerId) return;
          this.subtitleSyncPointerDragging = false;
          this.subtitleSyncPointerId = null;
        };
        overlay.addEventListener("pointerup", stopDrag);
        overlay.addEventListener("pointercancel", stopDrag);
      }
    },
    refreshSubtitleSynchronizationOverlay() {
      const overlay = this.uiRefs?.subtitleDelayOverlay;
      if (!overlay || !this.subtitleDelayOverlayVisible) return;
      const model = this.getSubtitleSynchronizationModel();
      const text = (selector, value) => {
        const node = overlay.querySelector(selector);
        if (node && node.textContent !== value) node.textContent = value;
      };
      const toggle = overlay.querySelector('[data-subtitle-delay-focus="automatic"]');
      toggle?.setAttribute("aria-checked", String(model.enabled));
      toggle?.setAttribute(
        "title",
        `${t("subtitle_sync_auto_mode", {}, "Automatic")}: ${model.enabled ? t("subtitle_style_on", {}, "On") : t("subtitle_style_off", {}, "Off")}`
      );
      const state = !model.enabled
        ? "off"
        : model.status === "checking"
          ? "checking"
          : model.status === "synchronized"
            ? "synchronized"
            : "unavailable";
      overlay.querySelector("[data-subtitle-sync-state]")?.setAttribute("data-state", state);
      text("[data-subtitle-sync-status]", model.statusLabel);
      const visibility = (selector, visible) => {
        const node = overlay.querySelector(selector);
        node?.classList.toggle("hidden", !visible);
        node?.setAttribute("aria-hidden", String(!visible));
      };
      const failed = model.enabled && model.status === "unavailable";
      const noticeKey = failed ? String(this.selectedAddonSubtitleId) + ":" + String(this.subtitleSelectionToken) : "";
      if (this.subtitleSyncFailureNoticeKey !== noticeKey) {
        clearTimeout(this.subtitleSyncFailureNoticeTimer);
        this.subtitleSyncFailureNoticeTimer = null;
        this.subtitleSyncFailureNoticeKey = noticeKey;
        this.subtitleSyncFailureNoticeExpired = false;
        if (failed) {
          this.subtitleSyncFailureNoticeTimer = setTimeout(() => {
            this.subtitleSyncFailureNoticeTimer = null;
            if (!this.subtitleDelayOverlayVisible || this.subtitleSyncFailureNoticeKey !== noticeKey) return;
            this.subtitleSyncFailureNoticeExpired = true;
            this.refreshSubtitleSynchronizationOverlay();
          }, 3800);
          this.subtitleSyncFailureNoticeTimer.unref?.();
        }
      }
      visibility("[data-subtitle-sync-state]", model.enabled);
      const statusNode = overlay.querySelector("[data-subtitle-sync-state]");
      statusNode?.classList.toggle("faded", failed && this.subtitleSyncFailureNoticeExpired);
      statusNode?.setAttribute("aria-hidden", String(!model.enabled || (failed && this.subtitleSyncFailureNoticeExpired)));
      toggle?.setAttribute("aria-label", model.enabled && failed
        ? t("subtitle_automatic_sync_unavailable", {}, "No reliable match possible")
        : t("subtitle_sync_auto_mode", {}, "Automatic"));
      overlay.querySelector(".player-subtitle-sync-failure-dot")?.classList.toggle("hidden", !failed);
      text("[data-subtitle-sync-effective]", model.enabled && model.status === "synchronized" ? formatOffset(model.delayMs) : "");
      visibility("[data-subtitle-sync-adjustment]", model.showResult);
      visibility("[data-subtitle-sync-manual]", model.manual);
      visibility('[data-subtitle-delay-focus="sync"]', model.canAlign);
      const delayMs = model.delayMs;
      const { minimum, maximum } = this.getSubtitleSyncSliderRange(delayMs);
      text("[data-subtitle-sync-value]", formatOffset(delayMs));
      const slider = overlay.querySelector('[data-subtitle-delay-focus="slider"]');
      slider?.setAttribute("aria-valuemin", String(minimum));
      slider?.setAttribute("aria-valuemax", String(maximum));
      slider?.setAttribute("aria-valuenow", String(delayMs));
      slider?.setAttribute("aria-valuetext", formatSubtitleDelay(delayMs));
      const thumb = overlay.querySelector(".player-subtitle-delay-slider-thumb");
      const thumbPct = ((delayMs - minimum) / (maximum - minimum)) * 100;
      if (thumb) thumb.style.left = thumbPct.toFixed(3) + "%";
      const centerPct = ((0 - minimum) / (maximum - minimum)) * 100;
      const fill = overlay.querySelector(".player-subtitle-delay-slider-fill");
      if (fill) {
        fill.style.left = Math.min(thumbPct, centerPct).toFixed(3) + "%";
        fill.style.width = Math.abs(thumbPct - centerPct).toFixed(3) + "%";
      }
      for (const [name, enabled] of [
        ["sync", model.canAlign],
        ["slider", model.manual],
        ["reset", model.manual]
      ]) {
        const button = overlay.querySelector(`[data-subtitle-delay-focus="${name}"]`);
        if (button) {
          button.disabled = !enabled;
          button.classList.toggle("focusable", enabled);
        }
      }
      const active = overlay.querySelector(`[data-subtitle-delay-focus="${this.subtitleDelayFocusTarget}"]`);
      if (active?.disabled) {
        this.subtitleDelayFocusTarget = "automatic";
        this.syncSubtitleDelayOverlayFocusDom({ focus: true });
      }
    },
    refreshAutomaticSubtitleSyncDisplay() {
      this.refreshAutomaticSubtitleSyncStatusDisplay?.();
      this.refreshSubtitleSynchronizationOverlay();
    },
    syncSubtitleDelayOverlayFocusDom({ focus = false } = {}) {
      const overlay = this.uiRefs?.subtitleDelayOverlay;
      if (!overlay || !this.subtitleDelayOverlayVisible) return false;
      const target = overlay.querySelector(`[data-subtitle-delay-focus="${String(this.subtitleDelayFocusTarget || "slider")}"]`);
      if (!target || target.disabled) return false;
      overlay.querySelectorAll(".focused").forEach((node) => node.classList.remove("focused"));
      target.classList.add("focused");
      if (focus) {
        try {
          target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        } catch (_) {
          target.scrollIntoView?.();
        }
        if (document.activeElement !== target) target.focus?.();
      }
      return true;
    },
    setSubtitleDelayValue(delayMs, { showOverlay = false } = {}) {
      this.subtitleDelayMs = clamp(Math.trunc(Number(delayMs) || 0), SUBTITLE_DELAY_MIN_MS, SUBTITLE_DELAY_MAX_MS);
      if (this.isAssAddonSubtitleActive()) this.assSubtitleRenderer?.setDelay(this.subtitleDelayMs);
      this.persistSubtitleDelayPreference();
      this.applySubtitlePresentationSettings({ refreshTrackRendering: true });
      if (showOverlay) this.renderSubtitleDelayOverlay();
      this.renderSubtitleDialog();
    },
    setSubtitleSynchronizationDelayValue(delayMs, options = {}) {
      let manualMs = this.getSubtitleSynchronizationManualDelayMs(delayMs);
      if ((manualMs < SUBTITLE_DELAY_MIN_MS || manualMs > SUBTITLE_DELAY_MAX_MS) &&
          Math.abs(delayMs) <= SUBTITLE_DELAY_MAX_MS &&
          this.clearAutomaticSubtitleSyncMappingForManualAdjustment?.()) {
        manualMs = delayMs;
      }
      this.setSubtitleDelayValue(manualMs, options);
    },
    showSubtitleDelayOverlay() {
      this.flushPersistPlayerPresentationSettings();
      this.clearSubtitleDelayOverlayTimer();
      this.subtitleDelayOverlayVisible = true;
      this.subtitleDelayFocusTarget = this.getSubtitleSynchronizationModel().manual ? "slider" : "automatic";
      this.subtitleDelayOverlayStatus = "";
      this.subtitleTimingDialogVisible = false;
      this.subtitleDialogVisible = false;
      this.audioDialogVisible = false;
      this.speedDialogVisible = false;
      this.sourcesPanelVisible = false;
      this.setControlsVisible(false, { focus: false });
      this.renderSubtitleDialog();
      this.renderSubtitleTimingDialog();
      this.renderSubtitleDelayOverlay();
      this.updateModalBackdrop();
      setTimeout(() => this.syncSubtitleDelayOverlayFocusDom({ focus: true }), 80);
    },
    hideSubtitleDelayOverlay({ scheduleControls = true } = {}) {
      this.clearSubtitleDelayOverlayTimer();
      if (!this.subtitleDelayOverlayVisible) return false;
      this.subtitleDelayOverlayVisible = false;
      this.subtitleDelayOverlayStatus = "";
      this.renderSubtitleDelayOverlay();
      this.updateModalBackdrop();
      if (scheduleControls) this.resetControlsAutoHide();
      return true;
    },
    activateSubtitleSynchronizationAction(target) {
      const model = this.getSubtitleSynchronizationModel();
      if (target === "automatic") this.setAutomaticSubtitleSyncEnabled(!model.enabled);
      else if (target === "reset" && model.manual) this.setSubtitleSynchronizationDelayValue(0, { showOverlay: true });
      else if (target === "sync" && model.canAlign) this.openSubtitleTimingDialog();
    },
    handleSubtitleDelayOverlayKey(event) {
      const code = Number(event?.keyCode || 0);
      if (code !== 37 && code !== 39) this.subtitleSyncHeldKey = null;
      const model = this.getSubtitleSynchronizationModel();
      let target = String(this.subtitleDelayFocusTarget || "automatic");
      if ((!model.manual && ["slider", "sync", "reset"].includes(target)) ) {
        target = "automatic";
        this.subtitleDelayFocusTarget = target;
        this.syncSubtitleDelayOverlayFocusDom({ focus: true });
      }
      if (model.manual && target === "slider" && (code === 37 || code === 39)) {
        const now = Date.now();
        const prev = this.subtitleSyncHeldKey;
        if (!event?.repeat || prev !== code) this.subtitleSyncHeldSince = now;
        this.subtitleSyncHeldKey = code;
        const heldFor = event?.repeat ? now - (this.subtitleSyncHeldSince || now) : 0;
        const increment = event?.shiftKey ? 10 : heldFor > 1550 ? 500 : heldFor > 650 ? 200 : SUBTITLE_DELAY_STEP_MS;
        this.setSubtitleSynchronizationDelayValue(model.delayMs + (code === 39 ? 1 : -1) * increment, {
          showOverlay: true
        });
        return true;
      }
      const rows = [["automatic"]];
      if (model.manual) rows.push(["slider"], [...(model.canAlign ? ["sync"] : []), "reset"]);
      let row = rows.findIndex((items) => items.includes(target));
      let next = target;
      if (row < 0) {
        row = 0;
        next = "automatic";
      }
      if (code === 38 || code === 40) {
        const nextRow = rows[clamp(row + (code === 40 ? 1 : -1), 0, rows.length - 1)];
        next = nextRow[Math.min(Math.max(0, rows[row].indexOf(target)), nextRow.length - 1)];
      } else if (code === 37 || code === 39) {
        const rtl = String(document?.documentElement?.dir || document?.dir || "").toLowerCase() === "rtl";
        const direction = (code === 39 ? 1 : -1) * (rtl ? -1 : 1);
        next = rows[row][clamp(rows[row].indexOf(target) + direction, 0, rows[row].length - 1)];
      } else if (isSelectKeyCode(code)) this.activateSubtitleSynchronizationAction(target);
      if (next !== target) {
        this.subtitleDelayFocusTarget = next;
        this.syncSubtitleDelayOverlayFocusDom({ focus: true });
      }
      return true;
    },
    handleSubtitleDelayOverlayPointer(target, event) {
      const action = target?.closest?.("[data-subtitle-delay-focus]");
      if (!action || action.disabled || !this.subtitleDelayOverlayVisible) return false;
      this.subtitleDelayFocusTarget = String(action.dataset.subtitleDelayFocus || "slider");
      this.syncSubtitleDelayOverlayFocusDom({ focus: false });
      if (this.subtitleDelayFocusTarget === "slider") {
        this.setSubtitleSyncOffsetFromPointer(event, action);
      } else {
        this.activateSubtitleSynchronizationAction(this.subtitleDelayFocusTarget);
      }
      return true;
    },
    resetSubtitleAutoSyncState(clearLoadedTrack = true) {
      this.subtitleAutoSyncLoadToken = Number(this.subtitleAutoSyncLoadToken || 0) + 1;
      this.subtitleAutoSyncCues = [];
      this.subtitleAutoSyncCapturedVideoMs = null;
      this.subtitleAutoSyncStatus = "";
      this.subtitleAutoSyncError = "";
      this.subtitleAutoSyncLoading = false;
      if (clearLoadedTrack) {
        this.subtitleAutoSyncLoadedTrackKey = "";
      }
    },
    async loadSubtitleAutoSyncCues({ force = false } = {}) {
      const selectedSubtitle = this.getSelectedAddonSubtitle();
      if (!selectedSubtitle) {
        this.subtitleAutoSyncCues = [];
        this.subtitleAutoSyncCapturedVideoMs = null;
        this.subtitleAutoSyncLoading = false;
        this.subtitleAutoSyncError = t("subtitle_auto_sync_select_addon_track", {}, "Select an addon subtitle track to use Auto Sync.");
        this.subtitleAutoSyncLoadedTrackKey = "";
        this.renderSubtitleTimingDialog();
        return;
      }

      const selectedTrackKey = this.getSubtitleAutoSyncTrackKey(selectedSubtitle);
      if (!force && this.subtitleAutoSyncLoadedTrackKey === selectedTrackKey && this.subtitleAutoSyncCues.length) {
        return;
      }

      const loadToken = Number(this.subtitleAutoSyncLoadToken || 0) + 1;
      this.subtitleAutoSyncLoadToken = loadToken;
      this.subtitleAutoSyncLoading = true;
      this.subtitleAutoSyncError = "";
      this.subtitleAutoSyncStatus = "";
      if (force) {
        this.subtitleAutoSyncCues = [];
        this.subtitleAutoSyncCapturedVideoMs = null;
      }
      this.subtitleAutoSyncLoadedTrackKey = selectedTrackKey;
      this.renderSubtitleTimingDialog();

      try {
        const subtitleUrl = String(selectedSubtitle.url || "").trim();
        const languageHint = selectedSubtitle.lang || selectedSubtitle.language || selectedSubtitle.languageCode || "";
        let raw = null;
        try {
          raw = await this.fetchSubtitleRawBody(subtitleUrl, {
            timeoutMs: 10000,
            languageHint,
            subtitleHeaders: selectedSubtitle?.headers
          });
        } catch (directError) {
          if (!Environment.isTizen()) {
            throw directError;
          }
          const proxyUrl = await this.resolveTizenAvPlaySubtitleUrl(subtitleUrl);
          if (!proxyUrl || proxyUrl === subtitleUrl) {
            throw directError;
          }
          raw = await this.fetchSubtitleRawBody(proxyUrl, {
            timeoutMs: 10000,
            languageHint
          });
        }
        if (!raw?.body) {
          throw new Error("Subtitle body is empty");
        }

        const parsedCues = this.parseSubtitleCues(raw.body)
          .map((cue) => ({
            startTimeMs: Math.max(0, Math.round(Number(cue.start || 0) * 1000)),
            endTimeMs: Math.max(0, Math.round(Number(cue.end || 0) * 1000)),
            text: String(cue.text || "").trim()
          }))
          .filter((cue) => cue.text && cue.endTimeMs > cue.startTimeMs);

        if (
          loadToken !== this.subtitleAutoSyncLoadToken ||
          selectedTrackKey !== this.getSubtitleAutoSyncTrackKey(this.getSelectedAddonSubtitle())
        ) {
          return;
        }
        this.subtitleAutoSyncLoading = false;
        this.subtitleAutoSyncCues = parsedCues;
        this.subtitleAutoSyncError = parsedCues.length
          ? ""
          : t("subtitle_timing_file_no_lines", {}, "No subtitle lines were found in this file.");
        this.renderSubtitleTimingDialog();
        if (this.subtitleTimingDialogVisible && this.subtitleTimingStage === "pick") {
          setTimeout(() => this.syncSubtitleTimingFocusDom({ focus: true }), 50);
        }
      } catch (error) {
        if (loadToken !== this.subtitleAutoSyncLoadToken) {
          return;
        }
        this.subtitleAutoSyncLoading = false;
        this.subtitleAutoSyncCues = [];
        this.subtitleAutoSyncError = t("subtitle_timing_load_lines_failed", {}, "Failed to load subtitle lines.");
        this.renderSubtitleTimingDialog();
        console.warn("Subtitle auto-sync cue load failed", {
          error: error?.message || String(error || "")
        });
      }
    },
    openSubtitleTimingDialog() {
      this.clearSubtitleDelayOverlayTimer();
      this.subtitleDelayOverlayVisible = false;
      this.subtitleDelayOverlayStatus = "";
      this.subtitleDialogVisible = false;
      this.audioDialogVisible = false;
      this.speedDialogVisible = false;
      this.sourcesPanelVisible = false;
      this.subtitleTimingDialogVisible = true;
      this.subtitleTimingStage = "wait";
      this.subtitleAutoSyncCapturedVideoMs = null;
      this.subtitleAutoSyncStatus = "";
      this.subtitleAutoSyncError = "";
      this.subtitleAutoSyncCueFocusIndex = 0;
      this.setControlsVisible(false, { focus: false });
      this.renderSubtitleDialog();
      this.renderSubtitleDelayOverlay();
      this.renderSubtitleTimingDialog();
      this.updateModalBackdrop();
      void this.loadSubtitleAutoSyncCues({ force: false });
      setTimeout(() => this.syncSubtitleTimingFocusDom({ focus: true }), 120);
    },
    dismissSubtitleTimingDialog() {
      const returnToSynchronization = Boolean(this.subtitleTimingDialogVisible);
      this.subtitleAutoSyncLoadToken = Number(this.subtitleAutoSyncLoadToken || 0) + 1;
      this.subtitleAutoSyncCapturedVideoMs = null;
      this.subtitleAutoSyncStatus = "";
      this.subtitleAutoSyncError = "";
      this.subtitleAutoSyncLoading = false;
      this.subtitleTimingDialogVisible = false;
      this.subtitleTimingStage = "wait";
      this.renderSubtitleTimingDialog();
      this.updateModalBackdrop();
      if (returnToSynchronization) this.showSubtitleDelayOverlay();
    }
  };
}
