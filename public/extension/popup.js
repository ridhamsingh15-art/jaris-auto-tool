/**
 * JARVIS Auto-Pilot — Popup UI Controller
 * Canonical Manifest V3 Module (popup.js)
 *
 * Connects every popup control to real state in chrome.storage.local and dispatches
 * session lifecycle actions via chrome.runtime or local SessionController.
 */
(function (root) {
  'use strict';

  const StorageMod = root.JarvisStorage;
  const ControllerMod = root.JarvisSessionController;

  if (!StorageMod || !ControllerMod) return;

  function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Never';
    const diffSec = Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 1000));
    if (diffSec < 5) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ${diffMin % 60}m ago`;
  }

  async function sendExtensionCommand(payload) {
    if (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.sendMessage === 'function'
    ) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      });
    }
    return null;
  }

  function bindPopupToDocument(doc, customStorage, customController) {
    if (!doc) return null;
    const storage = customStorage || new StorageMod.JarvisStorageEngine();
    const localController =
      customController || new ControllerMod.SessionController({ storage });

    const el = {
      stateIndicator: doc.getElementById('stateIndicator'),
      modeReadout: doc.getElementById('modeReadout'),
      checkpointStatusText: doc.getElementById('checkpointStatusText'),
      lastActivityText: doc.getElementById('lastActivityText'),
      errorBanner: doc.getElementById('errorBanner'),
      errorCodeText: doc.getElementById('errorCodeText'),
      errorMessageText: doc.getElementById('errorMessageText'),
      ambiguityResolutionBar: doc.getElementById('ambiguityResolutionBar'),
      confirmSentBtn: doc.getElementById('confirmSentBtn'),
      confirmNotSentBtn: doc.getElementById('confirmNotSentBtn'),
      startBtn: doc.getElementById('startBtn'),
      approveBtn: doc.getElementById('approveBtn'),
      pauseBtn: doc.getElementById('pauseBtn'),
      resumeBtn: doc.getElementById('resumeBtn'),
      emergencyStopBtn: doc.getElementById('emergencyStopBtn'),
      openOptionsBtn: doc.getElementById('openOptionsBtn'),
      turnsCompletedVal: doc.getElementById('turnsCompletedVal'),
      operationModeSelect: doc.getElementById('operationModeSelect'),
      maxTurnsInput: doc.getElementById('maxTurnsInput'),
      maxRuntimeInput: doc.getElementById('maxRuntimeInput'),
      promptDelayInput: doc.getElementById('promptDelayInput'),
      objectiveInput: doc.getElementById('objectiveInput'),
      milestoneInput: doc.getElementById('milestoneInput'),
      nextActionReadout: doc.getElementById('nextActionReadout'),
      contextInput: doc.getElementById('contextInput'),
      saveContextBtn: doc.getElementById('saveContextBtn'),
      sessionIdText: doc.getElementById('sessionIdText'),
      saveFeedbackText: doc.getElementById('saveFeedbackText')
    };

    if (!el.stateIndicator) return null;

    function showFeedback(text) {
      if (!el.saveFeedbackText) return;
      el.saveFeedbackText.textContent = text;
      setTimeout(() => {
        if (el.saveFeedbackText.textContent === text) {
          el.saveFeedbackText.textContent = '';
        }
      }, 2200);
    }

    function renderCheckpoint(cp, preserveFocusedInputs) {
      StorageMod.synchronizeTaskState(cp);
      const canonicalAction =
        StorageMod.resolveCanonicalActiveTask(cp) ||
        cp.nextProposedAction ||
        cp.currentMilestone ||
        'No action queued';

      el.stateIndicator.textContent = cp.state;
      el.stateIndicator.setAttribute('data-state', cp.state);
      el.modeReadout.textContent =
        cp.operationMode === 'SUPERVISED' ? 'Supervised Mode' : 'Bounded Autonomous';

      el.checkpointStatusText.textContent = `Checkpoint v${cp.schemaVersion}: ${
        cp.unresolvedSubmission ? 'Unresolved Lock Active' : 'Synchronized'
      }`;
      el.lastActivityText.textContent = `Last activity: ${formatRelativeTime(
        cp.timestamps && cp.timestamps.lastSuccessfulActivityAt
      )}`;

      el.turnsCompletedVal.textContent = `${cp.turnCount} / ${cp.maxTurns}`;
      el.sessionIdText.textContent = `Session: ${cp.sessionId.slice(0, 18)}`;
      el.nextActionReadout.textContent = canonicalAction;

      if (!preserveFocusedInputs) {
        el.operationModeSelect.value = cp.operationMode;
        el.maxTurnsInput.value = String(cp.maxTurns);
        el.maxRuntimeInput.value = String(Math.round(cp.maxRuntimeMs / 60000));
        el.promptDelayInput.value = String(Math.round(cp.promptDelayMs / 1000));
        el.objectiveInput.value = cp.projectObjective || '';
        el.milestoneInput.value = cp.currentMilestone || '';
        el.contextInput.value = cp.projectContext || '';
      }

      // Render error / interruption alert
      if (cp.lastError || cp.state === 'INTERRUPTED' || cp.state === 'ERROR') {
        el.errorBanner.classList.remove('hidden');
        el.errorCodeText.textContent =
          (cp.lastError && cp.lastError.code) || cp.state;
        el.errorMessageText.textContent =
          (cp.lastError && cp.lastError.message) ||
          'Session interrupted. Verify state before continuing.';

        if (cp.unresolvedSubmission) {
          el.ambiguityResolutionBar.classList.remove('hidden');
        } else {
          el.ambiguityResolutionBar.classList.add('hidden');
        }
      } else {
        el.errorBanner.classList.add('hidden');
        el.ambiguityResolutionBar.classList.add('hidden');
      }

      // Button visibility & enablement
      if (cp.state === 'WAITING_FOR_APPROVAL') {
        el.approveBtn.classList.remove('hidden');
      } else {
        el.approveBtn.classList.add('hidden');
      }

      if (cp.state === 'PAUSED' || cp.state === 'INTERRUPTED' || cp.state === 'ERROR') {
        el.resumeBtn.classList.remove('hidden');
        el.pauseBtn.classList.add('hidden');
      } else {
        el.resumeBtn.classList.add('hidden');
        el.pauseBtn.classList.remove('hidden');
        el.pauseBtn.disabled =
          cp.state === 'IDLE' || cp.state === 'STOPPED' || cp.state === 'COMPLETED';
      }
    }

    function readFormOverrides() {
      return {
        operationMode: el.operationModeSelect.value,
        maxTurns: Math.max(1, Number(el.maxTurnsInput.value || 8)),
        maxRuntimeMs: Math.max(1, Number(el.maxRuntimeInput.value || 120)) * 60000,
        promptDelayMs: Math.max(1, Number(el.promptDelayInput.value || 5)) * 1000,
        projectObjective: el.objectiveInput.value.trim(),
        currentMilestone: el.milestoneInput.value.trim(),
        projectContext: el.contextInput.value.trim()
      };
    }

    // Live update Next Planned Action readout when Current Milestone is edited in Popup
    el.milestoneInput.addEventListener('input', () => {
      const val = el.milestoneInput.value.trim();
      if (val && el.nextActionReadout) {
        el.nextActionReadout.textContent = val;
      }
    });

    async function persistFormEdits() {
      const overrides = readFormOverrides();
      const saved = await storage.saveConfiguration(
        overrides,
        'Updated configuration from Popup.'
      );
      renderCheckpoint(saved, false);
      showFeedback('Checkpoint saved');
      return saved;
    }

    el.saveContextBtn.addEventListener('click', () => {
      persistFormEdits();
    });

    el.operationModeSelect.addEventListener('change', () => {
      persistFormEdits();
    });

    el.startBtn.addEventListener('click', async () => {
      const overrides = readFormOverrides();
      await storage.saveConfiguration(overrides, 'Synchronized configuration before starting session.');
      const resp = await sendExtensionCommand({
        type: 'JARVIS_START_SESSION',
        overrides
      });
      const cp =
        resp && resp.checkpoint
          ? resp.checkpoint
          : await localController.startSession(overrides);
      renderCheckpoint(cp, false);
      showFeedback('Session started');
    });

    el.approveBtn.addEventListener('click', async () => {
      await persistFormEdits();
      const resp = await sendExtensionCommand({ type: 'JARVIS_APPROVE_SUBMIT' });
      const cp =
        resp && resp.checkpoint
          ? resp.checkpoint
          : await localController.approveAndSubmitPrompt();
      renderCheckpoint(cp, false);
      showFeedback('Turn approved');
    });

    el.pauseBtn.addEventListener('click', async () => {
      const resp = await sendExtensionCommand({
        type: 'JARVIS_PAUSE_SESSION',
        reason: 'Paused by user from Popup.'
      });
      const cp =
        resp && resp.checkpoint
          ? resp.checkpoint
          : await localController.pauseSession('Paused by user from Popup.');
      renderCheckpoint(cp, false);
      showFeedback('Paused');
    });

    el.resumeBtn.addEventListener('click', async () => {
      const resp = await sendExtensionCommand({ type: 'JARVIS_RESUME_SESSION' });
      const cp =
        resp && resp.checkpoint
          ? resp.checkpoint
          : await localController.resumeSession();
      renderCheckpoint(cp, false);
      showFeedback('Resumed');
    });

    el.emergencyStopBtn.addEventListener('click', async () => {
      const resp = await sendExtensionCommand({
        type: 'JARVIS_EMERGENCY_STOP',
        reason: 'Emergency Stop pressed in Popup.'
      });
      const cp =
        resp && resp.checkpoint
          ? resp.checkpoint
          : await localController.emergencyStop('Emergency Stop pressed in Popup.');
      renderCheckpoint(cp, false);
      showFeedback('EMERGENCY STOP ACTIVE');
    });

    el.confirmSentBtn.addEventListener('click', async () => {
      const resp = await sendExtensionCommand({
        type: 'JARVIS_RESOLVE_AMBIGUOUS',
        resolution: 'CONFIRMED_SENT'
      });
      const cp =
        resp && resp.checkpoint
          ? resp.checkpoint
          : await localController.resolveAmbiguousSubmission('CONFIRMED_SENT');
      renderCheckpoint(cp, false);
    });

    el.confirmNotSentBtn.addEventListener('click', async () => {
      const resp = await sendExtensionCommand({
        type: 'JARVIS_RESOLVE_AMBIGUOUS',
        resolution: 'CONFIRMED_NOT_SENT'
      });
      const cp =
        resp && resp.checkpoint
          ? resp.checkpoint
          : await localController.resolveAmbiguousSubmission('CONFIRMED_NOT_SENT');
      renderCheckpoint(cp, false);
    });

    el.openOptionsBtn.addEventListener('click', () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else if (typeof window !== 'undefined') {
        window.open('options.html', '_blank');
      }
    });

    // Initial load
    storage.loadCheckpoint().then((cp) => renderCheckpoint(cp, false));

    return {
      storage,
      controller: localController,
      refresh: async () => {
        const cp = await storage.loadCheckpoint();
        renderCheckpoint(cp, false);
        return cp;
      },
      persistFormEdits
    };
  }

  if (typeof document !== 'undefined' && document.getElementById('stateIndicator')) {
    bindPopupToDocument(document);
  }

  root.JarvisPopupController = { bindPopupToDocument };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.JarvisPopupController;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
