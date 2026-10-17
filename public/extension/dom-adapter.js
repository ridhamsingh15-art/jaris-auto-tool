/**
 * JARVIS Auto-Pilot — Isolated ChatGPT DOM Adapter
 * Canonical Manifest V3 Module (dom-adapter.js)
 *
 * Responsibilities:
 * - Locate the active conversation and message composer on chatgpt.com using multi-selector fallbacks
 * - Detect whether response generation is currently active
 * - Identify the most recent user and assistant messages safely
 * - Detect reliable response completion across 4 independent signals + stability polling
 * - Detect a visible, genuine "Continue generating" control without clicking unrelated buttons
 * - Safely prepare and submit a prompt, and verify its appearance in the conversation DOM
 * - Detect rate limits, authentication walls, network errors, or unavailable interaction
 * - Never access private undocumented APIs or execute untrusted page text
 */
(function (root) {
  'use strict';

  const StorageRef =
    root.JarvisStorage ||
    (typeof require === 'function' ? require('./storage.js') : null);

  const computeTextHash = StorageRef
    ? StorageRef.computeTextHash
    : function (str) {
        return 'hash_' + String(str || '').length;
      };

  const DEFAULT_SELECTORS = Object.freeze({
    composerInputs: [
      '#prompt-textarea',
      'div#prompt-textarea[contenteditable="true"]',
      'textarea[data-id="root"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Ask anything"]',
      'div[contenteditable="true"][role="textbox"]',
      'form textarea'
    ],
    sendButtons: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'form button[type="submit"][data-testid*="send"]'
    ],
    stopButtons: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop response"]'
    ],
    assistantMessages: [
      '[data-message-author-role="assistant"]',
      'article[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
      'div.agent-turn [data-message-author-role="assistant"]'
    ],
    userMessages: [
      '[data-message-author-role="user"]',
      'article[data-testid^="conversation-turn-"] [data-message-author-role="user"]'
    ],
    conversationTurns: [
      'article[data-testid^="conversation-turn-"]',
      '[data-testid^="conversation-turn-"]'
    ],
    continueButtons: [
      'button[data-testid="continue-button"]',
      'button[aria-label="Continue generating"]'
    ],
    authInterruptions: [
      '[data-testid="login-button"]',
      'button[data-testid="login-button"]',
      'a[href*="/auth/login"]',
      '#challenge-running',
      'iframe[src*="challenges.cloudflare.com"]'
    ]
  });

  const RATE_LIMIT_PATTERNS = [
    /you['’]ve reached the current usage cap/i,
    /you['’]ve hit the plus plan limit/i,
    /too many requests in 1 hour/i,
    /rate limit reached/i,
    /you have reached your.*limit/i,
    /try again after/i
  ];

  const NETWORK_ERROR_PATTERNS = [
    /something went wrong/i,
    /network error/i,
    /error in message stream/i,
    /failed to load conversation/i,
    /regenerate response/i
  ];

  class ChatGPTDomAdapter {
    constructor(options) {
      const opts = options || {};
      this.doc = opts.document || (typeof document !== 'undefined' ? document : null);
      this.win = opts.window || (typeof window !== 'undefined' ? window : null);
      this.selectors = Object.assign({}, DEFAULT_SELECTORS, opts.selectors || {});
      this.requiredStablePolls = Math.max(2, Number(opts.requiredStablePolls || 3));
      this._lastSnapshot = {
        messageId: null,
        textHash: null,
        length: 0,
        stablePolls: 0
      };
    }

    setDocument(doc, win) {
      this.doc = doc;
      if (win) this.win = win;
    }

    /**
     * Checks if an element is visibly rendered and interactive.
     */
    isVisible(el) {
      if (!el) return false;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
      if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) {
        return false;
      }
      return true;
    }

    /**
     * Finds the first visible matching element from an array of CSS selectors.
     */
    _queryFirstVisible(selectorList, rootNode) {
      const scope = rootNode || this.doc;
      if (!scope || typeof scope.querySelectorAll !== 'function') return null;
      for (const selector of selectorList) {
        try {
          const nodes = scope.querySelectorAll(selector);
          for (let i = 0; i < nodes.length; i++) {
            if (this.isVisible(nodes[i])) {
              return nodes[i];
            }
          }
        } catch (_e) {
          // Ignore unsupported selector syntax in custom overrides
        }
      }
      return null;
    }

    /**
     * Finds all visible elements matching any of the selectors in priority order.
     */
    _queryAllVisible(selectorList, rootNode) {
      const scope = rootNode || this.doc;
      if (!scope || typeof scope.querySelectorAll !== 'function') return [];
      for (const selector of selectorList) {
        try {
          const nodes = Array.from(scope.querySelectorAll(selector)).filter((n) =>
            this.isVisible(n)
          );
          if (nodes.length > 0) {
            return nodes;
          }
        } catch (_e) {
          // Continue to next fallback selector
        }
      }
      return [];
    }

    getConversationUrl() {
      if (this.win && this.win.location && this.win.location.href) {
        return String(this.win.location.href);
      }
      if (this.doc && this.doc.location && this.doc.location.href) {
        return String(this.doc.location.href);
      }
      return 'https://chatgpt.com/';
    }

    /**
     * Finds the active message composer input element (contenteditable ProseMirror div or textarea).
     */
    findComposer() {
      return this._queryFirstVisible(this.selectors.composerInputs);
    }

    findSendButton() {
      return this._queryFirstVisible(this.selectors.sendButtons);
    }

    findStopButton() {
      return this._queryFirstVisible(this.selectors.stopButtons);
    }

    /**
     * Detects a genuine visible "Continue generating" button using both data-testid/aria-label
     * and exact button text verification so unrelated buttons are never clicked.
     */
    findContinueButton() {
      const byTestId = this._queryFirstVisible(this.selectors.continueButtons);
      if (byTestId && !byTestId.disabled) {
        return byTestId;
      }

      if (!this.doc || typeof this.doc.querySelectorAll !== 'function') return null;
      const buttons = Array.from(this.doc.querySelectorAll('button'));
      for (const btn of buttons) {
        if (!this.isVisible(btn) || btn.disabled) continue;
        const label = (
          (btn.textContent || '') +
          ' ' +
          (btn.getAttribute('aria-label') || '')
        )
          .trim()
          .toLowerCase();
        if (label === 'continue generating' || label.includes('continue generating')) {
          return btn;
        }
      }
      return null;
    }

    /**
     * Detects authentication challenges, Cloudflare interstitials, or expired sessions.
     */
    detectAuthOrChallenge() {
      if (!this.doc) {
        return { blocked: true, reason: 'Document unavailable.' };
      }
      const authNode = this._queryFirstVisible(this.selectors.authInterruptions);
      if (authNode) {
        return {
          blocked: true,
          code: 'AUTH_OR_CHALLENGE_REQUIRED',
          reason: 'Authentication login prompt or security challenge detected on page.'
        };
      }

      const pageTitle = (this.doc.title || '').toLowerCase();
      if (pageTitle.includes('just a moment') || pageTitle.includes('log in')) {
        return {
          blocked: true,
          code: 'AUTH_OR_CHALLENGE_REQUIRED',
          reason: `Page title indicates login or challenge screen ("${this.doc.title}").`
        };
      }

      return { blocked: false, code: null, reason: null };
    }

    /**
     * Detects ChatGPT usage caps, rate limits, or stream error banners.
     */
    detectRateLimitOrErrorBanner() {
      if (!this.doc) return { detected: false, type: null, message: null };

      const alertNodes = Array.from(
        this.doc.querySelectorAll(
          '[role="alert"], [data-testid*="limit"], [data-testid*="error"], .text-red-500, .border-red-500'
        )
      );

      for (const node of alertNodes) {
        if (!this.isVisible(node)) continue;
        const text = (node.textContent || '').trim();
        if (!text) continue;

        for (const pattern of RATE_LIMIT_PATTERNS) {
          if (pattern.test(text)) {
            return {
              detected: true,
              type: 'RATE_LIMIT',
              message: text.slice(0, 240)
            };
          }
        }

        for (const pattern of NETWORK_ERROR_PATTERNS) {
          if (pattern.test(text)) {
            return {
              detected: true,
              type: 'STREAM_OR_NETWORK_ERROR',
              message: text.slice(0, 240)
            };
          }
        }
      }

      // Also inspect buttons for "Regenerate" error state when no composer is ready
      const buttons = Array.from(this.doc.querySelectorAll('button'));
      for (const btn of buttons) {
        if (!this.isVisible(btn)) continue;
        const txt = (btn.textContent || '').trim();
        if (/^regenerate$/i.test(txt) || /try again/i.test(txt)) {
          const alertText = txt;
          if (
            this.doc.body &&
            RATE_LIMIT_PATTERNS.some((rx) => rx.test(this.doc.body.textContent || ''))
          ) {
            return {
              detected: true,
              type: 'RATE_LIMIT',
              message: 'ChatGPT usage limit detected in conversation view.'
            };
          }
          if (
            btn.getAttribute('data-testid') === 'regenerate-thread-error-button' ||
            /try again/i.test(alertText)
          ) {
            return {
              detected: true,
              type: 'STREAM_OR_NETWORK_ERROR',
              message: `Error recovery button visible ("${alertText}").`
            };
          }
        }
      }

      return { detected: false, type: null, message: null };
    }

    /**
     * Returns all visible user messages in chronological order.
     */
    getUserMessages() {
      const nodes = this._queryAllVisible(this.selectors.userMessages);
      return nodes.map((el, idx) => {
        const text = (el.textContent || '').trim();
        const messageId =
          el.getAttribute('data-message-id') ||
          (el.closest('[data-testid]') && el.closest('[data-testid]').getAttribute('data-testid')) ||
          `user_msg_${idx + 1}`;
        return {
          messageId,
          text,
          textHash: computeTextHash(text),
          element: el
        };
      });
    }

    /**
     * Returns all visible assistant messages in chronological order.
     */
    getAssistantMessages() {
      const nodes = this._queryAllVisible(this.selectors.assistantMessages);
      return nodes.map((el, idx) => {
        const text = (el.textContent || '').trim();
        const messageId =
          el.getAttribute('data-message-id') ||
          (el.closest('[data-testid]') && el.closest('[data-testid]').getAttribute('data-testid')) ||
          `assistant_msg_${idx + 1}`;
        const isStreamingNode =
          el.classList.contains('result-streaming') ||
          Boolean(el.querySelector('.result-streaming, [data-testid="streaming-indicator"]'));
        return {
          messageId,
          text,
          length: text.length,
          textHash: computeTextHash(text),
          isStreamingNode,
          element: el
        };
      });
    }

    getLatestAssistantMessage() {
      const list = this.getAssistantMessages();
      return list.length > 0 ? list[list.length - 1] : null;
    }

    /**
     * Multi-signal check for whether assistant generation is currently active.
     * Never assumes a missing Stop button alone means generation is complete.
     */
    isGenerating() {
      const stopBtn = this.findStopButton();
      if (stopBtn) return true;

      if (this.doc) {
        const streamingNodes = this.doc.querySelectorAll(
          '.result-streaming, [data-testid="streaming-indicator"], [data-streaming="true"]'
        );
        for (let i = 0; i < streamingNodes.length; i++) {
          if (this.isVisible(streamingNodes[i])) return true;
        }
      }

      const latest = this.getLatestAssistantMessage();
      if (latest && latest.isStreamingNode) return true;

      return false;
    }

    /**
     * Evaluates the full page state and updates stability poll counters for the latest
     * assistant response.
     *
     * Completion requires ALL of:
     * 1. No active generation indicator (no Stop button, no streaming class/attribute)
     * 2. Composer is present and interactive (not blocked by auth/error)
     * 3. Latest assistant message is non-empty
     * 4. Latest assistant message textHash & length have remained identical across
     *    `requiredStablePolls` consecutive observations.
     */
    observePageState() {
      const auth = this.detectAuthOrChallenge();
      const banner = this.detectRateLimitOrErrorBanner();
      const composer = this.findComposer();
      const sendButton = this.findSendButton();
      const stopButton = this.findStopButton();
      const continueButton = this.findContinueButton();
      const latestAssistant = this.getLatestAssistantMessage();
      const userMessages = this.getUserMessages();
      const generating = this.isGenerating();

      let stablePolls = 0;
      if (latestAssistant && latestAssistant.length > 0 && !generating) {
        if (
          this._lastSnapshot.messageId === latestAssistant.messageId &&
          this._lastSnapshot.textHash === latestAssistant.textHash &&
          this._lastSnapshot.length === latestAssistant.length
        ) {
          stablePolls = this._lastSnapshot.stablePolls + 1;
        } else {
          stablePolls = 1;
        }
        this._lastSnapshot = {
          messageId: latestAssistant.messageId,
          textHash: latestAssistant.textHash,
          length: latestAssistant.length,
          stablePolls
        };
      } else {
        this._lastSnapshot = {
          messageId: latestAssistant ? latestAssistant.messageId : null,
          textHash: latestAssistant ? latestAssistant.textHash : null,
          length: latestAssistant ? latestAssistant.length : 0,
          stablePolls: 0
        };
      }

      const interactionAvailable =
        !auth.blocked &&
        Boolean(composer) &&
        !composer.disabled &&
        composer.getAttribute('aria-disabled') !== 'true';

      const isResponseComplete =
        !auth.blocked &&
        !banner.detected &&
        !generating &&
        interactionAvailable &&
        Boolean(latestAssistant && latestAssistant.length > 0) &&
        stablePolls >= this.requiredStablePolls;

      return {
        url: this.getConversationUrl(),
        interactionAvailable,
        hasComposer: Boolean(composer),
        hasSendButton: Boolean(sendButton),
        hasStopButton: Boolean(stopButton),
        hasContinueButton: Boolean(continueButton),
        isGenerating: generating,
        isResponseComplete,
        stablePolls,
        requiredStablePolls: this.requiredStablePolls,
        userMessageCount: userMessages.length,
        latestUserMessage: userMessages.length > 0 ? userMessages[userMessages.length - 1] : null,
        latestAssistantMessage: latestAssistant
          ? {
              messageId: latestAssistant.messageId,
              text: latestAssistant.text,
              textHash: latestAssistant.textHash,
              length: latestAssistant.length
            }
          : null,
        authChallenge: auth,
        errorOrLimit: banner,
        observedAt: Date.now()
      };
    }

    /**
     * Safely populates the ChatGPT composer and triggers submission without clicking
     * unrelated buttons or silently switching conversations.
     */
    submitPrompt(promptText, expectedConversationUrl) {
      const cleanPrompt = String(promptText || '').trim();
      if (!cleanPrompt) {
        return { ok: false, code: 'EMPTY_PROMPT', reason: 'Cannot submit an empty prompt.' };
      }

      const auth = this.detectAuthOrChallenge();
      if (auth.blocked) {
        return { ok: false, code: auth.code, reason: auth.reason };
      }

      const banner = this.detectRateLimitOrErrorBanner();
      if (banner.detected) {
        return { ok: false, code: banner.type, reason: banner.message };
      }

      if (this.isGenerating()) {
        return {
          ok: false,
          code: 'GENERATION_ALREADY_ACTIVE',
          reason: 'Cannot submit a prompt while ChatGPT is actively generating a response.'
        };
      }

      if (expectedConversationUrl) {
        const currentUrl = this.getConversationUrl();
        if (currentUrl !== expectedConversationUrl) {
          return {
            ok: false,
            code: 'CONVERSATION_URL_MISMATCH',
            reason: `Conversation URL changed from "${expectedConversationUrl}" to "${currentUrl}". Refusing to submit.`
          };
        }
      }

      const composer = this.findComposer();
      if (!composer) {
        return {
          ok: false,
          code: 'COMPOSER_NOT_FOUND',
          reason: 'Message composer element could not be located on page.'
        };
      }

      // Populate either a textarea or a ProseMirror contenteditable div
      const tagName = (composer.tagName || '').toUpperCase();
      if (tagName === 'TEXTAREA' || tagName === 'INPUT') {
        composer.focus();
        composer.value = cleanPrompt;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        composer.focus();
        composer.textContent = cleanPrompt;
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: cleanPrompt }));
      }

      // Locate the Send button after input events update button disabled state
      const sendBtn = this.findSendButton();
      if (!sendBtn) {
        return {
          ok: false,
          code: 'SEND_BUTTON_NOT_FOUND',
          reason: 'Prompt was staged in composer, but no valid Send button was found.'
        };
      }
      if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
        return {
          ok: false,
          code: 'SEND_BUTTON_DISABLED',
          reason: 'Send button is disabled after populating prompt.'
        };
      }

      sendBtn.click();

      return {
        ok: true,
        code: 'SUBMIT_TRIGGERED',
        promptHash: computeTextHash(cleanPrompt),
        submittedAt: Date.now()
      };
    }

    /**
     * Verifies that a submitted prompt actually appeared as a user turn in the
     * active conversation DOM.
     */
    verifySubmission(promptTextOrHash, TurnIdOptional) {
      const targetHash =
        typeof promptTextOrHash === 'string' && promptTextOrHash.startsWith('fnv1a_')
          ? promptTextOrHash
          : computeTextHash(String(promptTextOrHash || ''));

      const userMessages = this.getUserMessages();
      for (let i = userMessages.length - 1; i >= 0; i--) {
        const msg = userMessages[i];
        if (msg.textHash === targetHash) {
          return {
            verified: true,
            messageId: msg.messageId,
            matchedBy: 'EXACT_HASH'
          };
        }
        if (
          TurnIdOptional &&
          msg.text &&
          msg.text.includes(String(TurnIdOptional))
        ) {
          return {
            verified: true,
            messageId: msg.messageId,
            matchedBy: 'TURN_ID_MARKER'
          };
        }
      }

      return {
        verified: false,
        messageId: null,
        matchedBy: null
      };
    }

    /**
     * Safely clicks the verified "Continue generating" button if and only if
     * it is visible, enabled, and no generation is currently active.
     */
    clickContinueGenerating() {
      if (this.isGenerating()) {
        return {
          ok: false,
          code: 'ALREADY_GENERATING',
          reason: 'Generation is already active; refusing to click Continue.'
        };
      }

      const continueBtn = this.findContinueButton();
      if (!continueBtn) {
        return {
          ok: false,
          code: 'CONTINUE_BUTTON_NOT_FOUND',
          reason: 'No visible Continue generating control found.'
        };
      }

      continueBtn.click();
      this._lastSnapshot.stablePolls = 0;
      return {
        ok: true,
        code: 'CONTINUE_CLICKED',
        clickedAt: Date.now()
      };
    }
  }

  const exported = {
    DEFAULT_SELECTORS,
    RATE_LIMIT_PATTERNS,
    NETWORK_ERROR_PATTERNS,
    ChatGPTDomAdapter
  };

  root.JarvisDomAdapter = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
