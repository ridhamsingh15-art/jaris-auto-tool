/**
 * JARVIS Auto-Pilot — Future Local Coding Agent Integration Point
 * Canonical Manifest V3 Module (local-agent-bridge.js)
 *
 * Purpose:
 * Preserves a clean, fail-closed extension hook for future integration with the local
 * Windows 11 JARVIS coding agent (Planner-Registry-Executor) without claiming that
 * the Chrome Extension itself grants ChatGPT direct filesystem or test-runner access.
 */
(function (root) {
  'use strict';

  class LocalAgentBridge {
    constructor(config) {
      this.config = Object.assign(
        {
          mode: 'NONE', // 'NONE' | 'LOOPBACK_READONLY'
          endpoint: ''
        },
        config || {}
      );
    }

    isEnabled() {
      return this.config.mode === 'LOOPBACK_READONLY' && Boolean(this.config.endpoint);
    }

    /**
     * Returns an explicit capability disclosure appended to prompts or UI status
     * so neither the user nor ChatGPT mistakes browser automation for local disk access.
     */
    getCapabilityDisclosure() {
      if (!this.isEnabled()) {
        return 'Local Agent Bridge: DISABLED (Browser-Only Mode). ChatGPT has NO direct access to the local Windows 11 filesystem or pytest runner unless output is explicitly provided in the checkpoint.';
      }
      return `Local Agent Bridge: READ-ONLY TELEMETRY (${this.config.endpoint}). Consequential or write operations remain blocked.`;
    }

    /**
     * Hook invoked when a milestone completes. Fail-closed by default.
     */
    async notifyMilestoneComplete(milestonePayload) {
      if (!this.isEnabled()) {
        return {
          bridged: false,
          status: 'DISABLED_BY_DEFAULT',
          note: 'Local coding agent bridge is inactive; checkpoint persisted in chrome.storage.local.'
        };
      }
      return {
        bridged: false,
        status: 'DEFERRED_TO_LOCAL_HOST',
        payloadSummary: milestonePayload && milestonePayload.milestone ? milestonePayload.milestone : ''
      };
    }
  }

  const exported = { LocalAgentBridge };
  root.JarvisLocalAgentBridge = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
