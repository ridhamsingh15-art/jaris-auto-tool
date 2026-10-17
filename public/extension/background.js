/**
 * JARVIS Auto-Pilot — Manifest V3 Background Service Worker
 * Canonical Manifest V3 Module (background.js)
 *
 * Responsibilities:
 * - Coordinate recoverable background scheduling via chrome.alarms
 * - Handle service-worker suspension and browser restart recovery safely
 * - Route commands between Popup, Options, and the active ChatGPT Content Script
 * - Enforce Emergency Stop immediately across all extension contexts
 */
if (typeof importScripts === 'function') {
  try {
    importScripts('storage.js', 'local-agent-bridge.js', 'session-controller.js');
  } catch (err) {
    console.error('[JARVIS Auto-Pilot] Failed to import scripts in service worker:', err);
  }
}

(function (root) {
  'use strict';

  const ALARM_NAME = 'jarvis_autopilot_watchdog';
  const StorageMod = root.JarvisStorage;
  const ControllerMod = root.JarvisSessionController;

  const storage = StorageMod ? new StorageMod.JarvisStorageEngine() : null;
  const controller =
    StorageMod && ControllerMod
      ? new ControllerMod.SessionController({ storage })
      : null;

  /**
   * Finds the active or most recently active ChatGPT tab.
   */
  async function findChatGPTTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
      return null;
    }
    return new Promise((resolve) => {
      chrome.tabs.query({ url: 'https://chatgpt.com/*' }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          resolve(null);
          return;
        }
        const activeTab = tabs.find((t) => t.active) || tabs[0];
        resolve(activeTab);
      });
    });
  }

  /**
   * Sends a message to the ChatGPT content script if a tab is open.
   */
  async function sendToContentScript(payload) {
    const tab = await findChatGPTTab();
    if (!tab || !tab.id) {
      return {
        ok: false,
        code: 'NO_CHATGPT_TAB',
        reason: 'No open https://chatgpt.com tab found. Open ChatGPT to run session actions.'
      };
    }

    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, payload, (response) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve({
            ok: false,
            code: 'CONTENT_SCRIPT_UNREACHABLE',
            reason:
              'ChatGPT tab is open, but the content script did not respond. Reload the ChatGPT tab and try again.'
          });
          return;
        }
        resolve(response || { ok: true });
      });
    });
  }

  /**
   * Configures or clears the recoverable chrome.alarms watchdog based on session state.
   */
  async function syncWatchdogAlarm(state) {
    if (typeof chrome === 'undefined' || !chrome.alarms) return;
    const activeStates = ['READY', 'SUBMITTING', 'GENERATING', 'CONTINUING', 'PAUSED'];
    if (activeStates.includes(state)) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
    } else {
      chrome.alarms.clear(ALARM_NAME);
    }
  }

  /**
   * Runs startup/install recovery so an interrupted SUBMITTING turn is never
   * blindly re-sent after a browser restart or extension reload.
   */
  async function performLifecycleRecovery(triggerSource) {
    if (!storage || !controller) return null;
    const cp = await storage.loadCheckpoint();

    if (cp.state === 'SUBMITTING' || cp.unresolvedSubmission) {
      // Attempt to ask the content script if the turn is visible in DOM
      const ping = await sendToContentScript({
        type: 'JARVIS_RECOVERY_CHECK',
        turnId: cp.currentTurnId,
        promptHash: cp.unresolvedSubmission ? cp.unresolvedSubmission.promptHash : null
      });

      if (ping && ping.ok && ping.verifiedInDom) {
        cp.unresolvedSubmission = null;
        cp.turnCount += 1;
        cp.lastError = null;
        const recovered = await controller.transitionState(
          cp,
          'GENERATING',
          `Recovered (${triggerSource}): verified turn ${cp.currentTurnId} in ChatGPT DOM.`
        );
        await syncWatchdogAlarm(recovered.state);
        return recovered;
      }

      // Ambiguous submission -> transition to INTERRUPTED for manual confirmation
      const halted = await controller.recoverFromRestart();
      await syncWatchdogAlarm(halted.state);
      return halted;
    }

    await syncWatchdogAlarm(cp.state);
    return cp;
  }

  // Register Chrome MV3 lifecycle listeners when running in Chrome extension context
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
      performLifecycleRecovery('onInstalled');
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
      performLifecycleRecovery('onStartup');
    });
  }

  if (typeof chrome !== 'undefined' && chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm && alarm.name === ALARM_NAME) {
        const cp = await storage.loadCheckpoint();
        if (cp.state === 'STOPPED' || cp.state === 'IDLE' || cp.state === 'COMPLETED') {
          await syncWatchdogAlarm(cp.state);
          return;
        }
        await sendToContentScript({ type: 'JARVIS_ALARM_TICK' });
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      (async () => {
        if (!message || typeof message.type !== 'string') {
          sendResponse({ ok: false, reason: 'Invalid message payload.' });
          return;
        }

        if (message.type === 'JARVIS_GET_CHECKPOINT') {
          const cp = await storage.loadCheckpoint();
          sendResponse({ ok: true, checkpoint: cp });
          return;
        }

        if (message.type === 'JARVIS_EMERGENCY_STOP') {
          const stopped = await controller.emergencyStop(
            message.reason || 'Emergency Stop triggered by user.'
          );
          await syncWatchdogAlarm('STOPPED');
          await sendToContentScript({ type: 'JARVIS_EMERGENCY_STOP_BROADCAST' });
          sendResponse({ ok: true, checkpoint: stopped });
          return;
        }

        if (
          [
            'JARVIS_START_SESSION',
            'JARVIS_PAUSE_SESSION',
            'JARVIS_RESUME_SESSION',
            'JARVIS_APPROVE_SUBMIT',
            'JARVIS_RESOLVE_AMBIGUOUS',
            'JARVIS_STEP_NOW'
          ].includes(message.type)
        ) {
          // Forward DOM-dependent actions to the active ChatGPT content script first
          const forwarded = await sendToContentScript(message);
          if (forwarded && forwarded.ok && forwarded.checkpoint) {
            await syncWatchdogAlarm(forwarded.checkpoint.state);
            sendResponse(forwarded);
            return;
          }

          // Fallback if no ChatGPT tab is active yet (e.g., staging session in Popup/Options)
          if (message.type === 'JARVIS_START_SESSION') {
            const cp = await controller.startSession(message.overrides || {});
            await syncWatchdogAlarm(cp.state);
            sendResponse({ ok: true, checkpoint: cp, warning: forwarded.reason });
            return;
          }
          if (message.type === 'JARVIS_PAUSE_SESSION') {
            const cp = await controller.pauseSession(message.reason);
            await syncWatchdogAlarm(cp.state);
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }
          if (message.type === 'JARVIS_RESUME_SESSION') {
            const cp = await controller.resumeSession();
            await syncWatchdogAlarm(cp.state);
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }
          if (message.type === 'JARVIS_RESOLVE_AMBIGUOUS') {
            const cp = await controller.resolveAmbiguousSubmission(message.resolution);
            await syncWatchdogAlarm(cp.state);
            sendResponse({ ok: true, checkpoint: cp });
            return;
          }

          sendResponse(forwarded);
          return;
        }

        sendResponse({ ok: false, reason: `Unhandled message type: ${message.type}` });
      })().catch((err) => {
        sendResponse({
          ok: false,
          reason: err && err.message ? err.message : String(err)
        });
      });

      return true; // Async sendResponse
    });
  }

  const exported = {
    ALARM_NAME,
    findChatGPTTab,
    sendToContentScript,
    syncWatchdogAlarm,
    performLifecycleRecovery
  };

  root.JarvisBackground = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
