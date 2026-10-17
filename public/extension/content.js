/**
 * JARVIS Auto-Pilot — ChatGPT Content Script Coordinator
 * Canonical Manifest V3 Module (content.js)
 *
 * Responsibilities:
 * - Bind ChatGPTDomAdapter and SessionController to the visible chatgpt.com page
 * - Run non-invasive periodic observation ticks when a session is active
 * - Manage optional Screen Wake Lock safely (with explicit fallback when unsupported)
 * - Respond immediately to Popup, Options, and Background Service Worker commands
 */
(function (root) {
  'use strict';

  const StorageMod = root.JarvisStorage;
  const DomMod = root.JarvisDomAdapter;
  const ControllerMod = root.JarvisSessionController;

  if (!StorageMod || !DomMod || !ControllerMod) {
    return;
  }

  const storage = new StorageMod.JarvisStorageEngine();
  const domAdapter = new DomMod.ChatGPTDomAdapter({
    document: typeof document !== 'undefined' ? document : null,
    window: typeof window !== 'undefined' ? window : null,
    requiredStablePolls: 3
  });
  const controller = new ControllerMod.SessionController({
    storage,
    domAdapter
  });

  let pollTimerId = null;
  let wakeLockSentinel = null;
  let isTickRunning = false;

  /**
   * Attempts to acquire or release a Screen Wake Lock when supported and enabled.
   * Note: Cannot guarantee Windows 11 stays awake or prevent OS/network interruptions.
   */
  async function syncWakeLock(enabled) {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) {
      return { supported: false, active: false };
    }
    try {
      if (enabled && !wakeLockSentinel && document.visibilityState === 'visible') {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
        return { supported: true, active: true };
      }
      if (!enabled && wakeLockSentinel) {
        await wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
      return { supported: true, active: Boolean(wakeLockSentinel) };
    } catch (_err) {
      return { supported: true, active: false };
    }
  }

  async function runSingleTick() {
    if (isTickRunning) return null;
    isTickRunning = true;
    try {
      const cp = await controller.step();
      await syncWakeLock(
        cp.wakeLockEnabled &&
          ['READY', 'SUBMITTING', 'GENERATING', 'CONTINUING', 'WAITING_FOR_APPROVAL'].includes(
            cp.state
          )
      );
      return cp;
    } finally {
      isTickRunning = false;
    }
  }

  function startObservationLoop() {
    if (pollTimerId) return;
    pollTimerId = setInterval(() => {
      runSingleTick().catch(() => {});
    }, 1500);
  }

  function stopObservationLoop() {
    if (pollTimerId) {
      clearInterval(pollTimerId);
      pollTimerId = null;
    }
  }

  // Handle messages from background service worker or popup
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      (async () => {
        if (!message || typeof message.type !== 'string') {
          sendResponse({ ok: false });
          return;
        }

        switch (message.type) {
          case 'JARVIS_RECOVERY_CHECK': {
            const verification = domAdapter.verifySubmission(
              message.promptHash,
              message.turnId
            );
            sendResponse({
              ok: true,
              verifiedInDom: verification.verified,
              matchedBy: verification.matchedBy
            });
            return;
          }

          case 'JARVIS_EMERGENCY_STOP_BROADCAST': {
            stopObservationLoop();
            await syncWakeLock(false);
            const cp = await storage.loadCheckpoint();
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }

          case 'JARVIS_START_SESSION': {
            const cp = await controller.startSession(message.overrides || {});
            startObservationLoop();
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }

          case 'JARVIS_PAUSE_SESSION': {
            const cp = await controller.pauseSession(message.reason);
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }

          case 'JARVIS_RESUME_SESSION': {
            const cp = await controller.resumeSession();
            startObservationLoop();
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }

          case 'JARVIS_APPROVE_SUBMIT': {
            const cp = await controller.approveAndSubmitPrompt(message.customPrompt);
            startObservationLoop();
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }

          case 'JARVIS_RESOLVE_AMBIGUOUS': {
            const cp = await controller.resolveAmbiguousSubmission(message.resolution);
            startObservationLoop();
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }

          case 'JARVIS_STEP_NOW':
          case 'JARVIS_ALARM_TICK': {
            const cp = await runSingleTick();
            sendResponse({ ok: true, checkpoint: cp, pageState: domAdapter.observePageState() });
            return;
          }

          case 'JARVIS_INSPECT_DOM': {
            sendResponse({
              ok: true,
              pageState: domAdapter.observePageState()
            });
            return;
          }

          default:
            sendResponse({ ok: false, reason: `Unknown content action: ${message.type}` });
        }
      })().catch((err) => {
        sendResponse({
          ok: false,
          reason: err && err.message ? err.message : String(err)
        });
      });

      return true;
    });
  }

  // On content script boot in a real browser page, run safe restart recovery
  if (typeof window !== 'undefined' && window.location && window.location.hostname.includes('chatgpt.com')) {
    controller
      .recoverFromRestart()
      .then((cp) => {
        if (['READY', 'GENERATING', 'CONTINUING', 'PAUSED'].includes(cp.state)) {
          startObservationLoop();
        }
      })
      .catch(() => {});
  }

  root.JarvisContentCoordinator = {
    storage,
    domAdapter,
    controller,
    runSingleTick,
    startObservationLoop,
    stopObservationLoop
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
