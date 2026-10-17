/**
 * JARVIS Auto-Pilot — Comprehensive Automated Test Suite
 * Canonical Test Suite (tests/extension.test.js)
 *
 * Verifies all 16 required behavioral, safety, DOM, and recovery categories against
 * the single canonical Vanilla JS implementation in /public/extension/*.js.
 */
(function (root) {
  'use strict';

  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

  let StorageMod = root.JarvisStorage;
  let DomMod = root.JarvisDomAdapter;
  let ControllerMod = root.JarvisSessionController;
  let BridgeMod = root.JarvisLocalAgentBridge;


  function assert(condition, message) {
    if (!condition) {
      throw new Error(`Assertion Failed: ${message}`);
    }
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        `${message} — Expected "${String(expected)}", received "${String(actual)}"`
      );
    }
  }

  /**
   * Creates an isolated mock chrome.storage.local backend for deterministic testing.
   */
  function createMockChromeStorage(initialData) {
    const store = Object.assign({}, initialData || {});
    return {
      _store: store,
      get(keys, callback) {
        const kList = Array.isArray(keys) ? keys : [keys];
        const res = {};
        for (const k of kList) {
          if (Object.prototype.hasOwnProperty.call(store, k)) {
            res[k] = JSON.parse(JSON.stringify(store[k]));
          }
        }
        if (callback) callback(res);
        return Promise.resolve(res);
      },
      set(items, callback) {
        Object.keys(items).forEach((k) => {
          store[k] = JSON.parse(JSON.stringify(items[k]));
        });
        if (callback) callback();
        return Promise.resolve();
      }
    };
  }

  /**
   * Lightweight, realistic ChatGPT DOM Fixture simulator supporting querySelectorAll,
   * composer value updates, send/stop/continue button states, user/assistant turns,
   * rate-limit banners, and auth challenges.
   */
  function createMockChatGPTDom(config) {
    const state = Object.assign(
      {
        url: 'https://chatgpt.com/c/jarvis-mission-01',
        title: 'ChatGPT - Project JARVIS',
        hasComposer: true,
        composerDisabled: false,
        composerValue: '',
        hasSendButton: true,
        sendDisabled: false,
        isGenerating: false,
        hasContinueButton: false,
        autoEchoUserTurnOnSend: true,
        rateLimitBannerText: '',
        networkErrorBannerText: '',
        authChallengeActive: false,
        userTurns: [],
        assistantTurns: []
      },
      config || {}
    );

    const makeEl = (props) =>
      Object.assign(
        {
          tagName: 'DIV',
          hidden: false,
          disabled: false,
          style: {},
          classList: {
            _set: new Set(props && props.classes ? props.classes : []),
            contains(c) {
              return this._set.has(c);
            }
          },
          _attrs: Object.assign({}, (props && props.attrs) || {}),
          getAttribute(name) {
            return this._attrs[name] || null;
          },
          closest() {
            return null;
          },
          querySelector() {
            return null;
          },
          focus() {},
          dispatchEvent() {},
          click() {}
        },
        props || {}
      );

    const composerEl = makeEl({
      tagName: 'TEXTAREA',
      disabled: state.composerDisabled,
      value: state.composerValue,
      attrs: { id: 'prompt-textarea', placeholder: 'Message ChatGPT' },
      dispatchEvent() {}
    });

    const sendBtnEl = makeEl({
      tagName: 'BUTTON',
      disabled: state.sendDisabled,
      attrs: { 'data-testid': 'send-button', 'aria-label': 'Send prompt' },
      click() {
        state.composerValue = composerEl.value || composerEl.textContent || '';
        if (state.autoEchoUserTurnOnSend && state.composerValue) {
          state.userTurns.push({
            id: `user_turn_${state.userTurns.length + 1}`,
            text: state.composerValue
          });
          state.isGenerating = true;
        }
      }
    });

    const stopBtnEl = makeEl({
      tagName: 'BUTTON',
      attrs: { 'data-testid': 'stop-button', 'aria-label': 'Stop generating' }
    });

    const continueBtnEl = makeEl({
      tagName: 'BUTTON',
      textContent: 'Continue generating',
      attrs: {
        'data-testid': 'continue-button',
        'aria-label': 'Continue generating'
      },
      click() {
        state.hasContinueButton = false;
        state.isGenerating = true;
      }
    });

    const mockDoc = {
      get title() {
        return state.title;
      },
      location: {
        get href() {
          return state.url;
        }
      },
      body: {
        get textContent() {
          return (
            state.rateLimitBannerText +
            ' ' +
            state.networkErrorBannerText +
            ' ' +
            state.assistantTurns.map((t) => t.text).join(' ')
          );
        }
      },
      querySelectorAll(selector) {
        if (
          selector.includes('login-button') ||
          selector.includes('/auth/login') ||
          selector.includes('challenge')
        ) {
          return state.authChallengeActive
            ? [makeEl({ tagName: 'BUTTON', attrs: { 'data-testid': 'login-button' } })]
            : [];
        }

        if (
          selector.includes('#prompt-textarea') ||
          selector.includes('textarea') ||
          selector.includes('contenteditable')
        ) {
          composerEl.disabled = state.composerDisabled;
          return state.hasComposer ? [composerEl] : [];
        }

        if (selector.includes('send-button') || selector.includes('Send prompt')) {
          sendBtnEl.disabled = state.sendDisabled;
          return state.hasSendButton && !state.isGenerating ? [sendBtnEl] : [];
        }

        if (selector.includes('stop-button') || selector.includes('Stop generating')) {
          return state.isGenerating ? [stopBtnEl] : [];
        }

        if (selector.includes('continue-button') || selector.includes('Continue generating')) {
          return state.hasContinueButton ? [continueBtnEl] : [];
        }

        if (selector.includes('streaming-indicator') || selector.includes('result-streaming')) {
          return state.isGenerating
            ? [makeEl({ classes: ['result-streaming'] })]
            : [];
        }

        if (selector.includes('[data-message-author-role="user"]')) {
          return state.userTurns.map((u) =>
            makeEl({
              textContent: u.text,
              attrs: {
                'data-message-author-role': 'user',
                'data-message-id': u.id
              }
            })
          );
        }

        if (selector.includes('[data-message-author-role="assistant"]')) {
          return state.assistantTurns.map((a, idx) =>
            makeEl({
              textContent: a.text,
              classes:
                state.isGenerating && idx === state.assistantTurns.length - 1
                  ? ['result-streaming']
                  : [],
              attrs: {
                'data-message-author-role': 'assistant',
                'data-message-id': a.id || `asst_${idx + 1}`
              }
            })
          );
        }

        if (selector.includes('[role="alert"]')) {
          const alerts = [];
          if (state.rateLimitBannerText) {
            alerts.push(makeEl({ textContent: state.rateLimitBannerText }));
          }
          if (state.networkErrorBannerText) {
            alerts.push(makeEl({ textContent: state.networkErrorBannerText }));
          }
          return alerts;
        }

        if (selector === 'button') {
          const btns = [];
          if (state.hasSendButton && !state.isGenerating) btns.push(sendBtnEl);
          if (state.isGenerating) btns.push(stopBtnEl);
          if (state.hasContinueButton) btns.push(continueBtnEl);
          return btns;
        }

        return [];
      }
    };

    const mockWin = {
      location: {
        get href() {
          return state.url;
        }
      }
    };

    return { state, document: mockDoc, window: mockWin };
  }

  /**
   * Executes all 16 automated test categories and returns structured results.
   */
  async function runAllAutomatedTests() {
    StorageMod = root.JarvisStorage || StorageMod;
    BridgeMod = root.JarvisLocalAgentBridge || BridgeMod;
    DomMod = root.JarvisDomAdapter || DomMod;
    ControllerMod = root.JarvisSessionController || ControllerMod;

    const results = [];
    let currentTime = 1760000000000;
    const nowFn = () => currentTime;

    async function runTest(id, category, title, fn) {
      const started = Date.now();
      try {
        await fn();
        results.push({
          id,
          category,
          title,
          passed: true,
          durationMs: Date.now() - started,
          error: null
        });
      } catch (err) {
        results.push({
          id,
          category,
          title,
          passed: false,
          durationMs: Date.now() - started,
          error: err && err.message ? err.message : String(err)
        });
      }
    }

    // 1. State Transitions
    await runTest(
      'T01',
      'State Transitions',
      'Enforces permitted 12-state transitions and rejects illegal state jumps',
      async () => {
        const mockBackend = createMockChromeStorage();
        const storage = new StorageMod.JarvisStorageEngine(mockBackend);
        const controller = new ControllerMod.SessionController({ storage, nowFn });

        assert(
          controller.isTransitionPermitted('IDLE', 'READY'),
          'IDLE -> READY should be permitted'
        );
        assert(
          controller.isTransitionPermitted('READY', 'WAITING_FOR_APPROVAL'),
          'READY -> WAITING_FOR_APPROVAL should be permitted'
        );
        assert(
          controller.isTransitionPermitted('WAITING_FOR_APPROVAL', 'SUBMITTING'),
          'WAITING_FOR_APPROVAL -> SUBMITTING should be permitted'
        );
        assert(
          controller.isTransitionPermitted('SUBMITTING', 'GENERATING'),
          'SUBMITTING -> GENERATING should be permitted'
        );
        assert(
          !controller.isTransitionPermitted('IDLE', 'GENERATING'),
          'IDLE -> GENERATING must be rejected'
        );
        assert(
          !controller.isTransitionPermitted('STOPPED', 'SUBMITTING'),
          'STOPPED -> SUBMITTING must be rejected'
        );

        const cp = await storage.loadCheckpoint();
        let threwIllegal = false;
        try {
          await controller.transitionState(cp, 'GENERATING', 'Illegal jump from IDLE');
        } catch (_e) {
          threwIllegal = true;
        }
        assert(threwIllegal, 'transitionState must throw on illegal IDLE -> GENERATING');
      }
    );

    // 2. Checkpoint Persistence & Secret Redaction
    await runTest(
      'T02',
      'Checkpoint Persistence',
      'Persists versioned checkpoints in chrome.storage.local and redacts accidental API keys',
      async () => {
        const mockBackend = createMockChromeStorage();
        const storage = new StorageMod.JarvisStorageEngine(mockBackend);
        const cp = await storage.loadCheckpoint();
        cp.projectObjective = 'Test persistence with secret sk-proj1234567890abcdefghijklmno';
        await storage.saveCheckpoint(cp, 'Saved test objective');

        const reloaded = await storage.loadCheckpoint();
        assertEqual(reloaded.schemaVersion, 2, 'Schema version should be 2');
        assert(
          reloaded.projectObjective.includes('[REDACTED_API_KEY]'),
          'Secret key pattern must be automatically redacted on save'
        );
        assert(
          !reloaded.projectObjective.includes('sk-proj1234567890'),
          'Raw secret must never be stored in checkpoint'
        );
      }
    );

    // 3. Checkpoint Migration (v1 -> v2)
    await runTest(
      'T03',
      'Checkpoint Migration',
      'Migrates legacy v1 checkpoints to Schema v2 while preserving in-flight submission locks',
      async () => {
        const v1Data = {
          version: 1,
          sessionId: 'legacy_sess_01',
          state: 'SUBMITTING',
          mode: 'AUTONOMOUS',
          objective: 'Legacy v1 objective',
          pendingTasks: ['Legacy Task A', 'Legacy Task B'],
          completedTasks: ['Legacy Done 0'],
          inFlightPrompt: 'Prompt sent right before v1 upgrade',
          turnId: 'turn_v1_99',
          turns: 3
        };
        const mockBackend = createMockChromeStorage({
          [StorageMod.STORAGE_KEY_CHECKPOINT]: v1Data
        });
        const storage = new StorageMod.JarvisStorageEngine(mockBackend);
        const migrated = await storage.loadCheckpoint();

        assertEqual(migrated.schemaVersion, 2, 'Migrated schemaVersion must be 2');
        assertEqual(migrated.sessionId, 'legacy_sess_01', 'Preserves sessionId');
        assertEqual(migrated.turnCount, 3, 'Preserves turn count');
        assertEqual(migrated.pendingTasks.length, 2, 'Migrates string tasks to objects');
        assert(
          migrated.unresolvedSubmission !== null,
          'Preserves in-flight v1 prompt as unresolvedSubmission lock'
        );
        assertEqual(
          migrated.unresolvedSubmission.turnId,
          'turn_v1_99',
          'Preserves legacy turnId in lock'
        );
      }
    );

    // 4. Duplicate Submission Prevention (Single Unresolved Submission Invariant)
    await runTest(
      'T04',
      'Duplicate Submission Prevention',
      'Enforces invariant: at most one unresolved automated submission may exist in a session',
      async () => {
        const mockBackend = createMockChromeStorage();
        const storage = new StorageMod.JarvisStorageEngine(mockBackend);
        const domEnv = createMockChatGPTDom();
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({ operationMode: 'SUPERVISED' });
        const cp = await storage.loadCheckpoint();
        // Inject an existing unresolved submission lock
        cp.unresolvedSubmission = {
          turnId: 'turn_locked_1',
          promptText: 'In-flight prompt',
          promptHash: StorageMod.computeTextHash('In-flight prompt'),
          submittedAt: currentTime,
          verifiedInDom: false
        };
        await storage.saveCheckpoint(cp);

        const afterAttempt = await controller.approveAndSubmitPrompt();
        assertEqual(
          afterAttempt.state,
          'INTERRUPTED',
          'Must transition to INTERRUPTED when an unresolved submission already exists'
        );
        assertEqual(
          domEnv.state.userTurns.length,
          0,
          'Must NOT send a second prompt to the DOM when lock is active'
        );
        assertEqual(
          afterAttempt.lastError.code,
          'DUPLICATE_SUBMISSION_BLOCKED',
          'Records DUPLICATE_SUBMISSION_BLOCKED error code'
        );
      }
    );

    // 5. Submission Verification
    await runTest(
      'T05',
      'Submission Verification',
      'Verifies submitted prompt in conversation DOM and halts in INTERRUPTED if DOM confirmation fails',
      async () => {
        // Case A: Successful DOM echo -> transitions to GENERATING
        const storageA = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnvA = createMockChatGPTDom({ autoEchoUserTurnOnSend: true });
        const adapterA = new DomMod.ChatGPTDomAdapter(domEnvA);
        const controllerA = new ControllerMod.SessionController({
          storage: storageA,
          domAdapter: adapterA,
          nowFn
        });

        await controllerA.startSession({ operationMode: 'SUPERVISED' });
        const sentCp = await controllerA.approveAndSubmitPrompt();
        assertEqual(sentCp.state, 'GENERATING', 'Verified submission transitions to GENERATING');
        assertEqual(sentCp.turnCount, 1, 'Increments turnCount after verification');
        assertEqual(sentCp.unresolvedSubmission, null, 'Clears unresolved lock after verification');

        // Case B: Ambiguous DOM (Send clicked, but message did not appear in DOM) -> INTERRUPTED
        const storageB = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnvB = createMockChatGPTDom({ autoEchoUserTurnOnSend: false });
        const adapterB = new DomMod.ChatGPTDomAdapter(domEnvB);
        const controllerB = new ControllerMod.SessionController({
          storage: storageB,
          domAdapter: adapterB,
          nowFn
        });

        await controllerB.startSession({ operationMode: 'SUPERVISED' });
        const ambigCp = await controllerB.approveAndSubmitPrompt();
        assertEqual(
          ambigCp.state,
          'INTERRUPTED',
          'Unverified submission must stop in INTERRUPTED'
        );
        assert(
          ambigCp.unresolvedSubmission !== null,
          'Retains unresolvedSubmission lock when verification is ambiguous'
        );
      }
    );

    // 6. Multi-Signal Response Completion Detection
    await runTest(
      'T06',
      'Response Completion Detection',
      'Requires multiple consecutive stable observations and never assumes missing Stop button alone means complete',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom({ requiredStablePolls: 3 });
        const domAdapter = new DomMod.ChatGPTDomAdapter({
          document: domEnv.document,
          window: domEnv.window,
          requiredStablePolls: 3
        });
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({ operationMode: 'SUPERVISED' });
        await controller.approveAndSubmitPrompt();

        // Simulate streaming assistant text
        domEnv.state.assistantTurns.push({
          id: 'asst_turn_1',
          text: 'Working on SQLite checkpoint schema...'
        });

        // Tick 1 while isGenerating = true
        let cp = await controller.step();
        assertEqual(cp.state, 'GENERATING', 'Stays in GENERATING while streaming is active');

        // Stop button disappears, text finishes updating with structured checkpoint
        domEnv.state.isGenerating = false;
        domEnv.state.assistantTurns[0].text = [
          'Completed SQLite mission checkpoint table specification.',
          'Summary: Defined deterministic mission_checkpoints SQLite table with WAL mode.',
          'Files Changed: None (specification only)',
          'Tests Performed: Schema invariant review',
          'Unresolved Risks: None',
          'Next Proposed Milestone: M2: Implement Planner-Registry capability permission check before tool dispatch.'
        ].join('\n');

        // Poll 1 after streaming stopped (stablePolls = 1 < 3) -> must NOT complete yet!
        cp = await controller.step();
        assertEqual(
          cp.state,
          'GENERATING',
          'Does not complete on first poll after Stop button disappears (stablePolls=1)'
        );

        // Poll 2 (stablePolls = 2 < 3) -> still GENERATING
        cp = await controller.step();
        assertEqual(cp.state, 'GENERATING', 'Stays in GENERATING on stablePolls=2');

        // Poll 3 (stablePolls = 3 >= 3) -> transitions through RESPONSE_COMPLETE -> CONTINUING -> WAITING_FOR_APPROVAL
        cp = await controller.step();
        assertEqual(
          cp.state,
          'WAITING_FOR_APPROVAL',
          'Advances to WAITING_FOR_APPROVAL after 3 stable observations in Supervised Mode'
        );
        assertEqual(
          cp.completedTasks.length,
          1,
          'Records completed milestone in checkpoint'
        );
      }
    );

    // 7. Continuation Handling ("Continue generating")
    await runTest(
      'T07',
      'Continuation Handling',
      'Detects verified Continue generating control in Autonomous mode and enforces max continuations per turn',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom();
        const domAdapter = new DomMod.ChatGPTDomAdapter({
          document: domEnv.document,
          window: domEnv.window,
          requiredStablePolls: 2
        });
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({ operationMode: 'AUTONOMOUS' });
        await controller.step(); // Submits Turn 1 -> GENERATING

        // Simulate response pausing mid-stream with a visible "Continue generating" button
        domEnv.state.isGenerating = false;
        domEnv.state.hasContinueButton = true;
        domEnv.state.assistantTurns.push({
          id: 'asst_partial',
          text: 'Partial output requiring continuation...'
        });

        let cp = await controller.step();
        assertEqual(cp.state, 'GENERATING', 'Clicks Continue generating and returns to GENERATING');
        assertEqual(cp.continuationCount, 1, 'Increments continuationCount to 1');
        assertEqual(
          domEnv.state.hasContinueButton,
          false,
          'Continue button was clicked in DOM'
        );

        // Exceed maxContinuationsPerTurn (default 2)
        domEnv.state.isGenerating = false;
        domEnv.state.hasContinueButton = true;
        await controller.step(); // continuationCount = 2

        domEnv.state.isGenerating = false;
        domEnv.state.hasContinueButton = true;
        cp = await controller.step(); // Exceeds limit of 2 -> INTERRUPTED
        assertEqual(
          cp.state,
          'INTERRUPTED',
          'Halts in INTERRUPTED when maxContinuationsPerTurn is exceeded'
        );
      }
    );

    // 8. Retry Limits
    await runTest(
      'T08',
      'Retry Limits',
      'Transitions to ERROR after exhausting bounded retries on missing composer/recoverable failures',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom({ hasComposer: false });
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        const cpInit = await storage.loadCheckpoint();
        cpInit.maxRetries = 2;
        await storage.saveCheckpoint(cpInit);

        await controller.startSession({ operationMode: 'AUTONOMOUS' });

        // Attempt 1 -> PAUSED (retryCount = 1)
        let cp = await controller.step();
        assertEqual(cp.state, 'PAUSED', 'Attempt 1 pauses for retry');
        assertEqual(cp.retryCount, 1, 'retryCount is 1');

        // Advance clock past backoff -> READY -> Attempt 2 -> PAUSED (retryCount = 2)
        currentTime += 5000;
        await controller.step(); // PAUSED -> READY
        cp = await controller.step(); // READY -> Attempt 2 fails -> PAUSED
        assertEqual(cp.retryCount, 2, 'retryCount is 2');

        // Advance clock past backoff -> READY -> Attempt 3 exceeds maxRetries (2) -> ERROR
        currentTime += 10000;
        await controller.step(); // PAUSED -> READY
        cp = await controller.step(); // Exceeds maxRetries -> ERROR
        assertEqual(cp.state, 'ERROR', 'Transitions to ERROR when retryCount > maxRetries');
      }
    );

    // 9. Exponential Backoff Calculation
    await runTest(
      'T09',
      'Exponential Backoff',
      'Computes bounded exponential backoff delays and prevents premature retry before nextRetryAt',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const controller = new ControllerMod.SessionController({ storage, nowFn });

        const d1 = controller.computeBackoffDelayMs(1, 2000);
        const d2 = controller.computeBackoffDelayMs(2, 2000);
        const d3 = controller.computeBackoffDelayMs(3, 2000);
        const dCap = controller.computeBackoffDelayMs(10, 2000);

        assertEqual(d1, 2000, 'Retry 1 delay should be 2000ms');
        assertEqual(d2, 4000, 'Retry 2 delay should be 4000ms');
        assertEqual(d3, 8000, 'Retry 3 delay should be 8000ms');
        assertEqual(dCap, 60000, 'Backoff delay is capped at 60,000ms');
      }
    );

    // 10. Maximum-Turn Enforcement
    await runTest(
      'T10',
      'Maximum-Turn Enforcement',
      'Halts automatically in COMPLETED when completed turns reach maxTurns',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom();
        const domAdapter = new DomMod.ChatGPTDomAdapter({
          document: domEnv.document,
          window: domEnv.window,
          requiredStablePolls: 2
        });
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({
          operationMode: 'AUTONOMOUS',
          maxTurns: 1
        });

        // Submit Turn 1
        await controller.step();
        domEnv.state.isGenerating = false;
        domEnv.state.assistantTurns.push({
          id: 'asst_1',
          text: [
            'Summary: Completed Turn 1 analysis.',
            'Next Proposed Milestone: M2: Follow-up task.'
          ].join('\n')
        });

        await controller.step(); // stablePolls = 1
        const finalCp = await controller.step(); // stablePolls = 2 -> completes Turn 1 -> hits maxTurns (1/1)
        assertEqual(
          finalCp.state,
          'COMPLETED',
          'Session transitions to COMPLETED when turnCount reaches maxTurns'
        );
        assertEqual(finalCp.turnCount, 1, 'turnCount is 1');
      }
    );

    // 11. Maximum-Runtime Limits
    await runTest(
      'T11',
      'Runtime Limits',
      'Halts session in INTERRUPTED when elapsed session time exceeds maxRuntimeMs',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom();
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({
          operationMode: 'AUTONOMOUS',
          maxRuntimeMs: 120000 // 2 minutes
        });

        // Advance simulated clock by 3 minutes
        currentTime += 180000;
        const cp = await controller.step();
        assertEqual(
          cp.state,
          'INTERRUPTED',
          'Transitions to INTERRUPTED when maxRuntimeMs is exceeded'
        );
        assertEqual(
          cp.lastError.code,
          'MAX_RUNTIME_EXCEEDED',
          'Records MAX_RUNTIME_EXCEEDED code'
        );
      }
    );

    // 12. Emergency Stop Lockout
    await runTest(
      'T12',
      'Emergency Stop',
      'Immediately transitions to STOPPED from any state and blocks future automated submissions',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom();
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({ operationMode: 'AUTONOMOUS' });
        const stoppedCp = await controller.emergencyStop('Operator pressed Emergency Stop');
        assertEqual(stoppedCp.state, 'STOPPED', 'State is immediately STOPPED');

        // Stepping while STOPPED must never submit a prompt
        const afterStep = await controller.step();
        assertEqual(afterStep.state, 'STOPPED', 'Remains STOPPED across polling ticks');
        assertEqual(
          domEnv.state.userTurns.length,
          0,
          'Zero prompts submitted after Emergency Stop'
        );
      }
    );

    // 13. Pause and Resume
    await runTest(
      'T13',
      'Pause and Resume',
      'Safely pauses an active session and resumes to the appropriate supervised or autonomous state',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom();
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({ operationMode: 'SUPERVISED' });
        const paused = await controller.pauseSession('Operator pause');
        assertEqual(paused.state, 'PAUSED', 'Transitions to PAUSED');

        const stepWhilePaused = await controller.step();
        assertEqual(stepWhilePaused.state, 'PAUSED', 'Does not advance while PAUSED');

        const resumed = await controller.resumeSession();
        assertEqual(
          resumed.state,
          'WAITING_FOR_APPROVAL',
          'Resumes to WAITING_FOR_APPROVAL in Supervised Mode'
        );
      }
    );

    // 14. Browser and Service-Worker Recovery
    await runTest(
      'T14',
      'Browser & Service-Worker Recovery',
      'Recovers safely on restart: resumes GENERATING if turn is verified in DOM, or stops in INTERRUPTED if ambiguous',
      async () => {
        // Scenario 1: Ambiguous (message not in DOM after restart) -> INTERRUPTED
        const storage1 = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv1 = createMockChatGPTDom();
        const adapter1 = new DomMod.ChatGPTDomAdapter(domEnv1);
        const controller1 = new ControllerMod.SessionController({
          storage: storage1,
          domAdapter: adapter1,
          nowFn
        });

        const cp1 = await storage1.loadCheckpoint();
        cp1.state = 'SUBMITTING';
        cp1.currentTurnId = 'turn_crash_01';
        cp1.unresolvedSubmission = {
          turnId: 'turn_crash_01',
          promptText: 'Crash test prompt',
          promptHash: StorageMod.computeTextHash('Crash test prompt'),
          submittedAt: currentTime,
          verifiedInDom: false
        };
        await storage1.saveCheckpoint(cp1);

        const rec1 = await controller1.recoverFromRestart();
        assertEqual(
          rec1.state,
          'INTERRUPTED',
          'Stops in INTERRUPTED when crashed submission is not found in DOM'
        );

        // Operator resolves manually as CONFIRMED_NOT_SENT
        const resolved = await controller1.resolveAmbiguousSubmission('CONFIRMED_NOT_SENT');
        assertEqual(resolved.unresolvedSubmission, null, 'Clears lock after manual resolution');

        // Scenario 2: Message IS present in DOM after restart -> recovers to GENERATING
        const storage2 = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv2 = createMockChatGPTDom({
          userTurns: [{ id: 'u_1', text: 'Verified prompt [turn_crash_02]' }]
        });
        const adapter2 = new DomMod.ChatGPTDomAdapter(domEnv2);
        const controller2 = new ControllerMod.SessionController({
          storage: storage2,
          domAdapter: adapter2,
          nowFn
        });

        const cp2 = await storage2.loadCheckpoint();
        cp2.state = 'SUBMITTING';
        cp2.currentTurnId = 'turn_crash_02';
        cp2.unresolvedSubmission = {
          turnId: 'turn_crash_02',
          promptText: 'Verified prompt [turn_crash_02]',
          promptHash: StorageMod.computeTextHash('Verified prompt [turn_crash_02]'),
          submittedAt: currentTime,
          verifiedInDom: false
        };
        await storage2.saveCheckpoint(cp2);

        const rec2 = await controller2.recoverFromRestart();
        assertEqual(
          rec2.state,
          'GENERATING',
          'Transitions to GENERATING when submission is verified in DOM on recovery'
        );
        assertEqual(rec2.unresolvedSubmission, null, 'Clears lock on verified recovery');
      }
    );

    // 15. Missing or Changed DOM Elements & Unexpected Navigation
    await runTest(
      'T15',
      'Missing or Changed DOM Elements',
      'Detects missing composer selectors and unexpected conversation URL changes conservatively',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom({
          url: 'https://chatgpt.com/c/original-thread'
        });
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({ operationMode: 'AUTONOMOUS' });

        // Simulate unexpected page navigation to a different conversation
        domEnv.state.url = 'https://chatgpt.com/c/unrelated-thread';
        const cp = await controller.step();
        assertEqual(
          cp.state,
          'INTERRUPTED',
          'Halts in INTERRUPTED when conversation URL changes unexpectedly'
        );
        assertEqual(
          cp.lastError.code,
          'UNEXPECTED_NAVIGATION',
          'Records UNEXPECTED_NAVIGATION error'
        );
      }
    );

    // 16. Rate Limits, Authentication Failures, and Consequential Action Blocking
    await runTest(
      'T16',
      'Rate Limits, Auth & Safety Guards',
      'Halts immediately on ChatGPT usage caps, login challenges, or destructive command proposals',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom({
          rateLimitBannerText: "You've reached the current usage cap for GPT-4. Try again after 2:00 PM."
        });
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        await controller.startSession({ operationMode: 'AUTONOMOUS' });
        const cpLimit = await controller.step();
        assertEqual(
          cpLimit.state,
          'INTERRUPTED',
          'Halts in INTERRUPTED when ChatGPT rate limit banner is visible'
        );
        assertEqual(cpLimit.lastError.code, 'RATE_LIMIT', 'Records RATE_LIMIT code');

        // Also verify parser blocks destructive commands (e.g., rm -rf / git push --force)
        const dangerousParse = ControllerMod.parseAssistantResponse(
          'Summary: Cleaned workspace.\nNext Proposed Milestone: Run rm -rf / and git push --force'
        );
        assert(
          dangerousParse.consequentialActionDetected,
          'Detects consequential/destructive commands in assistant response'
        );
        assert(
          dangerousParse.requiresHumanIntervention,
          'Requires human intervention when destructive command is detected'
        );
      }
    );

    // 17. Canonical Active-Task Synchronization & Reset Preservation (Regression Suite)
    await runTest(
      'T17',
      'Task Synchronization & Reset',
      'Synchronizes currentMilestone, pendingTasks[0], nextProposedAction, and stagedPrompt across saves, turn completions, and session resets',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());
        const domEnv = createMockChatGPTDom({ requiredStablePolls: 2 });
        const domAdapter = new DomMod.ChatGPTDomAdapter(domEnv);
        const controller = new ControllerMod.SessionController({
          storage,
          domAdapter,
          nowFn
        });

        // 1. User replaces pendingTasks queue in Options without changing currentMilestone from default
        const customTasks = [
          'Phase 1: Audit JARVIS capability registry permissions',
          'Phase 2: Verify fail-closed executor sandbox rules',
          'Phase 3: Run Windows 11 integration test suite'
        ];
        const savedFromQueue = await storage.saveConfiguration({
          projectObjective: 'Verify custom JARVIS capability architecture',
          pendingTasks: customTasks
        });

        assertEqual(
          savedFromQueue.currentMilestone,
          customTasks[0],
          'currentMilestone synchronizes with new pendingTasks[0] head'
        );
        assertEqual(
          savedFromQueue.nextProposedAction,
          customTasks[0],
          'nextProposedAction synchronizes with canonical active task'
        );
        assertEqual(
          savedFromQueue.pendingTasks[0].title,
          customTasks[0],
          'pendingTasks[0].title matches currentMilestone'
        );

        // 2. User edits currentMilestone directly -> pendingTasks[0] and nextProposedAction must update to match
        const editedActiveTask = 'Phase 1 (Revised): Audit JARVIS capability registry & token scopes';
        const savedFromMilestone = await storage.saveConfiguration({
          currentMilestone: editedActiveTask,
          pendingTasks: customTasks
        });

        assertEqual(
          savedFromMilestone.currentMilestone,
          editedActiveTask,
          'currentMilestone reflects direct edit'
        );
        assertEqual(
          savedFromMilestone.pendingTasks[0].title,
          editedActiveTask,
          'pendingTasks[0].title updates to match edited currentMilestone'
        );
        assertEqual(
          savedFromMilestone.nextProposedAction,
          editedActiveTask,
          'nextProposedAction updates to match edited currentMilestone'
        );
        assertEqual(
          savedFromMilestone.pendingTasks.length,
          3,
          'Preserves remaining pending tasks in queue'
        );

        // 3. Start a Supervised session -> stagedPrompt and Next Planned Action must use the saved custom task
        const started = await controller.startSession({ operationMode: 'SUPERVISED' });
        assertEqual(started.state, 'WAITING_FOR_APPROVAL', 'Starts in WAITING_FOR_APPROVAL');
        assert(
          started.stagedPrompt.includes(editedActiveTask),
          'Constructed prompt uses the saved custom active task (never a stale task)'
        );
        assertEqual(
          StorageMod.resolveCanonicalActiveTask(started),
          editedActiveTask,
          'Canonical active task readout matches staged task'
        );

        // 4. Approve & complete Turn 1 -> queue must advance to customTasks[1] without losing or repeating items
        await controller.approveAndSubmitPrompt();
        domEnv.state.isGenerating = false;
        domEnv.state.assistantTurns.push({
          id: 'asst_sync_1',
          text: [
            'Summary: Completed capability registry & token scope audit.',
            'Files Changed: None',
            'Tests Performed: Verified permission schema',
            'Unresolved Risks: None',
            'Next Proposed Milestone: Phase 4: Document final capability audit report'
          ].join('\n')
        });
        await controller.step();
        await controller.step();
        const afterTurn1 = await controller.step();

        assertEqual(
          afterTurn1.completedTasks.length,
          1,
          'Completed task recorded in completedTasks'
        );
        assertEqual(
          afterTurn1.completedTasks[0].title,
          editedActiveTask,
          'Completed task title matches the exact active task that was executed'
        );
        assertEqual(
          afterTurn1.currentMilestone,
          customTasks[1],
          'Advances currentMilestone to the second queued task (Phase 2)'
        );
        assertEqual(
          afterTurn1.nextProposedAction,
          customTasks[1],
          'Advances nextProposedAction to Phase 2'
        );
        assertEqual(
          afterTurn1.pendingTasks[0].title,
          customTasks[1],
          'pendingTasks[0] is now Phase 2'
        );
        assert(
          afterTurn1.stagedPrompt.includes(customTasks[1]),
          'Next staged prompt targets Phase 2'
        );

        // 5. Reset session progress -> must preserve the user's saved configuration and task queue
        const afterProgressReset = await storage.resetCheckpoint();
        assertEqual(afterProgressReset.state, 'IDLE', 'Reset returns state to IDLE');
        assertEqual(afterProgressReset.turnCount, 0, 'Reset clears turnCount');
        assertEqual(
          afterProgressReset.currentMilestone,
          editedActiveTask,
          'Session reset preserves user-saved active task instead of restoring a stale factory default'
        );
        assertEqual(
          afterProgressReset.nextProposedAction,
          editedActiveTask,
          'Session reset preserves user-saved nextProposedAction'
        );

        // 6. Explicit factoryReset -> restores clean factory defaults
        const afterFactoryReset = await storage.resetCheckpoint({ factoryReset: true });
        assertEqual(
          afterFactoryReset.currentMilestone,
          StorageMod.DEFAULT_INITIAL_MILESTONE,
          'Explicit factoryReset restores default initial milestone'
        );
      }
    );

    // 18. Checkpoint JSON File & Textbox Import, Preview, Safety Clamping & Validation
    await runTest(
      'T18',
      'Checkpoint JSON Import & Safety',
      'Validates file/paste JSON imports, previews required fields, migrates v1->v2, clamps active states, and rejects invalid or locked imports without corrupting state',
      async () => {
        const storage = new StorageMod.JarvisStorageEngine(createMockChromeStorage());

        // Save a known baseline checkpoint first
        const baseline = await storage.saveConfiguration({
          projectObjective: 'Baseline Objective Before Import Tests',
          currentMilestone: 'Baseline Milestone M1',
          pendingTasks: ['Baseline Milestone M1', 'Baseline Milestone M2']
        });

        // 1. Reject malformed JSON, missing fields, unsupported future schemaVersion, invalid types, and invalid states
        const badCases = [
          { input: '{ malformed json ', expectedCode: 'MALFORMED_JSON' },
          {
            input: JSON.stringify({ schemaVersion: 99, sessionId: 's', projectObjective: 'o', state: 'IDLE' }),
            expectedCode: 'UNSUPPORTED_SCHEMA_VERSION'
          },
          {
            input: JSON.stringify({ schemaVersion: 2, sessionId: '', projectObjective: 'o', state: 'IDLE' }),
            expectedCode: 'MISSING_REQUIRED_FIELD'
          },
          {
            input: JSON.stringify({ schemaVersion: 2, sessionId: 's', projectObjective: 'o', state: 'FLYING' }),
            expectedCode: 'INVALID_SESSION_STATE'
          },
          {
            input: JSON.stringify({
              schemaVersion: 2,
              sessionId: 's',
              projectObjective: 'o',
              state: 'IDLE',
              pendingTasks: 'not-an-array'
            }),
            expectedCode: 'INVALID_FIELD_TYPE'
          }
        ];

        for (const tc of badCases) {
          const previewRes = await storage.previewCheckpointImport(tc.input);
          assertEqual(previewRes.ok, false, `Rejects invalid import (${tc.expectedCode})`);
          assertEqual(previewRes.code, tc.expectedCode, `Reports actionable code ${tc.expectedCode}`);
        }

        // Verify stored checkpoint remained completely untouched after failed imports
        const afterFailedImports = await storage.loadCheckpoint();
        assertEqual(
          afterFailedImports.projectObjective,
          baseline.projectObjective,
          'Preserves existing stored checkpoint unchanged when import validation fails'
        );

        // 2. Preview & commit a valid Schema v2 checkpoint (including FileReader / Blob text reading if available)
        const validV2Payload = {
          schemaVersion: 2,
          sessionId: 'jarvis_imported_v2_99',
          state: 'GENERATING', // Active loop state -> must be safely clamped on import!
          operationMode: 'SUPERVISED',
          projectObjective: 'Imported V2 Engineering Objective',
          projectContext: 'Imported Pinned Context',
          currentMilestone: 'Imported Milestone Alpha',
          pendingTasks: [
            { id: 't1', title: 'Imported Milestone Alpha', status: 'pending' },
            { id: 't2', title: 'Imported Milestone Beta', status: 'pending' }
          ],
          turnCount: 3,
          maxTurns: 10,
          unresolvedSubmission: null
        };

        let rawJsonString = JSON.stringify(validV2Payload, null, 2);
        if (
          root.JarvisOptionsController &&
          typeof root.JarvisOptionsController.readFileAsText === 'function' &&
          typeof Blob !== 'undefined'
        ) {
          const mockFile = new Blob([rawJsonString], { type: 'application/json' });
          rawJsonString = await root.JarvisOptionsController.readFileAsText(mockFile);
        }

        const stagedV2 = await storage.previewCheckpointImport(rawJsonString);
        assert(stagedV2.ok, 'Validates Schema v2 checkpoint JSON for preview');
        assertEqual(stagedV2.preview.schemaVersion, 2, 'Preview shows schemaVersion 2');
        assertEqual(
          stagedV2.preview.state,
          'WAITING_FOR_APPROVAL',
          'Clamps active GENERATING state to WAITING_FOR_APPROVAL in Supervised mode so import never auto-submits'
        );
        assertEqual(stagedV2.preview.pendingTaskCount, 2, 'Preview shows pendingTaskCount = 2');
        assertEqual(stagedV2.preview.turnCount, 3, 'Preview shows turnCount = 3');
        assertEqual(
          stagedV2.preview.currentMilestone,
          'Imported Milestone Alpha',
          'Preview shows active milestone'
        );
        assertEqual(
          stagedV2.preview.nextProposedAction,
          'Imported Milestone Alpha',
          'Preview shows synchronized nextProposedAction'
        );

        // Ensure preview alone did NOT overwrite storage before confirmation
        const beforeConfirm = await storage.loadCheckpoint();
        assertEqual(
          beforeConfirm.sessionId,
          baseline.sessionId,
          'Preview does not overwrite stored checkpoint before explicit confirmation'
        );

        // Explicitly confirm and commit import
        const committedV2 = await storage.commitCheckpointImport(stagedV2);
        assertEqual(
          committedV2.checkpoint.sessionId,
          'jarvis_imported_v2_99',
          'Commits imported session ID after confirmation'
        );
        assertEqual(
          committedV2.checkpoint.state,
          'WAITING_FOR_APPROVAL',
          'Persists safely clamped state on commit'
        );

        // 3. Preview & commit a legacy Schema v1 checkpoint
        const legacyV1Payload = {
          version: 1,
          sessionId: 'jarvis_legacy_v1_import',
          state: 'PAUSED',
          mode: 'AUTONOMOUS',
          objective: 'Legacy v1 Objective',
          pendingTasks: ['Legacy Task 1', 'Legacy Task 2'],
          turns: 1
        };
        const stagedV1 = await storage.previewCheckpointImport(JSON.stringify(legacyV1Payload));
        assert(stagedV1.ok, 'Validates and migrates legacy v1 checkpoint');
        assertEqual(stagedV1.preview.migratedFromVersion, 1, 'Preview notes migration from v1');
        assertEqual(stagedV1.preview.schemaVersion, 2, 'Migrated preview is Schema v2');
        assertEqual(
          stagedV1.preview.nextProposedAction,
          'Legacy Task 1',
          'Synchronizes nextProposedAction from v1 pendingTasks[0]'
        );

        // 4. Never clear an unresolved submission lock via import
        const lockedCp = await storage.loadCheckpoint();
        lockedCp.unresolvedSubmission = {
          turnId: 'turn_locked_99',
          promptText: 'In-flight prompt',
          promptHash: StorageMod.computeTextHash('In-flight prompt'),
          submittedAt: currentTime,
          verifiedInDom: false
        };
        await storage.saveCheckpoint(lockedCp);

        const blockedByLock = await storage.previewCheckpointImport(rawJsonString);
        assertEqual(
          blockedByLock.ok,
          false,
          'Blocks checkpoint import while current session has an unresolved submission lock'
        );
        assertEqual(
          blockedByLock.code,
          'ACTIVE_UNRESOLVED_SUBMISSION_LOCK',
          'Returns ACTIVE_UNRESOLVED_SUBMISSION_LOCK error code'
        );
      }
    );

    // 19. Editable Field Interaction, Value Retention, Save & Page-Reload Persistence
    await runTest(
      'T19',
      'Editable Field Interaction & Save',
      'Focuses and edits all settings and checkpoint JSON fields without mid-typing clobbering, saves configuration, and restores values on reload',
      async () => {
        const sharedBackend = createMockChromeStorage();
        const storage1 = new StorageMod.JarvisStorageEngine(sharedBackend);

        // Helper to create an interactive DOM fixture for Options Studio
        const createOptionsDomFixture = () => {
          const elements = {};
          const makeControl = (id, tag, type) => {
            const listeners = {};
            const el = {
              id,
              tagName: tag,
              type: type || '',
              value: '',
              checked: false,
              disabled: false,
              readOnly: false,
              textContent: '',
              style: {},
              focused: false,
              classList: {
                _classes: new Set(['hidden']),
                add(c) {
                  this._classes.add(c);
                },
                remove(c) {
                  this._classes.delete(c);
                },
                contains(c) {
                  return this._classes.has(c);
                }
              },
              focus() {
                this.focused = true;
              },
              addEventListener(evt, fn) {
                listeners[evt] = listeners[evt] || [];
                listeners[evt].push(fn);
              },
              trigger(evt, payload) {
                const fns = listeners[evt] || [];
                return Promise.all(fns.map((fn) => fn(payload || { target: el })));
              },
              click() {
                return this.trigger('click');
              }
            };
            elements[id] = el;
            return el;
          };

          [
            ['optObjective', 'TEXTAREA'],
            ['optContext', 'TEXTAREA'],
            ['optCurrentMilestone', 'INPUT', 'text'],
            ['optPendingTasks', 'TEXTAREA'],
            ['optNextActionReadout', 'DIV'],
            ['optMode', 'SELECT'],
            ['optMaxTurns', 'INPUT', 'number'],
            ['optMaxRuntimeMin', 'INPUT', 'number'],
            ['optPromptDelaySec', 'INPUT', 'number'],
            ['optMaxRetries', 'INPUT', 'number'],
            ['optBackoffBaseMs', 'INPUT', 'number'],
            ['optWakeLock', 'INPUT', 'checkbox'],
            ['optCheckpointFileInput', 'INPUT', 'file'],
            ['optSelectedFileName', 'SPAN'],
            ['optCheckpointJson', 'TEXTAREA'],
            ['optImportErrorBox', 'DIV'],
            ['optImportErrorCode', 'STRONG'],
            ['optImportErrorText', 'P'],
            ['optImportPreviewBox', 'DIV'],
            ['prevSchemaBadge', 'SPAN'],
            ['prevSessionId', 'CODE'],
            ['prevState', 'CODE'],
            ['prevMode', 'CODE'],
            ['prevTurns', 'CODE'],
            ['prevPendingCount', 'CODE'],
            ['prevUnresolved', 'CODE'],
            ['prevMilestone', 'DIV'],
            ['prevNextAction', 'DIV'],
            ['prevWarningsBox', 'DIV'],
            ['confirmImportCheckpointBtn', 'BUTTON'],
            ['cancelImportCheckpointBtn', 'BUTTON'],
            ['saveAllOptionsBtn', 'BUTTON'],
            ['importCheckpointBtn', 'BUTTON'],
            ['exportCheckpointBtn', 'BUTTON'],
            ['resetCheckpointBtn', 'BUTTON'],
            ['factoryResetCheckpointBtn', 'BUTTON'],
            ['optionsStatusFeedback', 'SPAN']
          ].forEach(([id, tag, type]) => makeControl(id, tag, type));

          return {
            elements,
            doc: {
              getElementById(id) {
                return elements[id] || null;
              },
              createElement() {
                return { click() {} };
              }
            }
          };
        };

        const OptionsCtrl = root.JarvisOptionsController;
        assert(Boolean(OptionsCtrl), 'JarvisOptionsController must be loaded');

        const dom1 = createOptionsDomFixture();
        const bound1 = OptionsCtrl.bindOptionsToDocument(dom1.doc, storage1);
        await bound1.ready;

        // 1. Verify all intended editable controls are enabled and not readOnly
        const editableIds = [
          'optObjective',
          'optContext',
          'optCurrentMilestone',
          'optPendingTasks',
          'optMode',
          'optMaxTurns',
          'optMaxRuntimeMin',
          'optPromptDelaySec',
          'optMaxRetries',
          'optBackoffBaseMs',
          'optCheckpointJson'
        ];
        for (const id of editableIds) {
          const ctrl = dom1.elements[id];
          assert(!ctrl.disabled && !ctrl.readOnly, `Field ${id} must be interactive and editable`);
          ctrl.focus();
          assert(ctrl.focused, `Field ${id} must accept focus`);
        }

        // 2. Focus and edit Pending Milestones, then edit Active Milestone, verifying neither overwrites the other mid-keystroke
        const customQueueText = 'Queue Step 1: Audit permissions\nQueue Step 2: Run unit tests';
        dom1.elements.optPendingTasks.value = customQueueText;
        await dom1.elements.optPendingTasks.trigger('input');
        assertEqual(
          dom1.elements.optPendingTasks.value,
          customQueueText,
          'Pending Milestones retains exact user input while typing'
        );
        assertEqual(
          dom1.elements.optNextActionReadout.textContent,
          'Queue Step 1: Audit permissions',
          'Derived Next Planned Action readout previews new queue head'
        );

        const customActiveMilestone = 'Override Step 1: Verify capability registry tokens';
        dom1.elements.optCurrentMilestone.value = customActiveMilestone;
        await dom1.elements.optCurrentMilestone.trigger('input');
        assertEqual(
          dom1.elements.optCurrentMilestone.value,
          customActiveMilestone,
          'Active Milestone retains exact user input while typing'
        );
        assertEqual(
          dom1.elements.optPendingTasks.value,
          customQueueText,
          'Typing in Active Milestone does NOT clobber Pending Milestones textarea before Save'
        );
        assertEqual(
          dom1.elements.optNextActionReadout.textContent,
          customActiveMilestone,
          'Derived Next Planned Action readout updates to reflect edited Active Milestone'
        );

        // 3. Edit all remaining configuration fields and click Save Configuration
        dom1.elements.optObjective.value = 'Custom Interactive Workbench Objective';
        dom1.elements.optContext.value = 'Custom Pinned Context Line 1\nLine 2';
        dom1.elements.optMode.value = 'SUPERVISED';
        dom1.elements.optMaxTurns.value = '14';
        dom1.elements.optMaxRuntimeMin.value = '90';
        dom1.elements.optPromptDelaySec.value = '9';
        dom1.elements.optMaxRetries.value = '5';
        dom1.elements.optBackoffBaseMs.value = '3500';
        dom1.elements.optWakeLock.checked = true;

        await bound1.saveConfiguration();

        assert(
          dom1.elements.optionsStatusFeedback.textContent.includes('saved'),
          'Displays clear save confirmation feedback'
        );

        // 4. Simulate reopening the page (fresh storage & DOM instance bound to sharedBackend)
        const storage2 = new StorageMod.JarvisStorageEngine(sharedBackend);
        const dom2 = createOptionsDomFixture();
        const bound2 = OptionsCtrl.bindOptionsToDocument(dom2.doc, storage2);
        await bound2.ready;

        assertEqual(
          dom2.elements.optObjective.value,
          'Custom Interactive Workbench Objective',
          'Reloaded page restores saved Project Objective'
        );
        assertEqual(
          dom2.elements.optContext.value,
          'Custom Pinned Context Line 1\nLine 2',
          'Reloaded page restores saved Pinned Context'
        );
        assertEqual(
          dom2.elements.optCurrentMilestone.value,
          customActiveMilestone,
          'Reloaded page restores saved Active Milestone'
        );
        assertEqual(
          dom2.elements.optNextActionReadout.textContent,
          customActiveMilestone,
          'Reloaded page restores synchronized Next Planned Action readout'
        );
        assertEqual(dom2.elements.optMaxTurns.value, '14', 'Reloaded page restores saved Max Turns');
        assertEqual(
          dom2.elements.optMaxRuntimeMin.value,
          '90',
          'Reloaded page restores saved Max Runtime (min)'
        );
        assertEqual(
          dom2.elements.optPromptDelaySec.value,
          '9',
          'Reloaded page restores saved Prompt Delay (sec)'
        );
        assertEqual(
          dom2.elements.optMaxRetries.value,
          '5',
          'Reloaded page restores saved Max Retries'
        );
        assertEqual(
          dom2.elements.optBackoffBaseMs.value,
          '3500',
          'Reloaded page restores saved Backoff Base (ms)'
        );
        assertEqual(
          dom2.elements.optWakeLock.checked,
          true,
          'Reloaded page restores saved Wake Lock toggle'
        );

        // 5. Verify Checkpoint JSON textbox editing + invalid import rejection preserves checkpoint
        dom2.elements.optCheckpointJson.value = '{ invalid json ';
        await dom2.elements.importCheckpointBtn.click();
        assert(
          !dom2.elements.optImportErrorBox.classList.contains('hidden'),
          'Shows error box when invalid JSON is validated in Options UI'
        );
        const preservedAfterBadJson = await storage2.loadCheckpoint();
        assertEqual(
          preservedAfterBadJson.projectObjective,
          'Custom Interactive Workbench Objective',
          'Does not overwrite existing checkpoint when JSON validation fails'
        );
      }
    );

    const passedCount = results.filter((r) => r.passed).length;
    const failedCount = results.length - passedCount;

    return {
      total: results.length,
      passed: passedCount,
      failed: failedCount,
      timestamp: Date.now(),
      environment: isNode ? 'Node.js Automated Test Runner (Mocked Chrome + DOM Fixtures)' : 'Browser Workbench Test Runner (Mocked Chrome + DOM Fixtures)',
      results
    };
  }

  const exported = {
    createMockChromeStorage,
    createMockChatGPTDom,
    runAllAutomatedTests
  };

  root.JarvisTestSuite = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  // If executed directly via `node tests/extension.test.js`, run and print report
  if (isNode && typeof require !== 'undefined' && require.main === module) {
    runAllAutomatedTests()
      .then((summary) => {
        console.log('===============================================================');
        console.log(`JARVIS AUTO-PILOT AUTOMATED TEST SUITE: ${summary.passed}/${summary.total} PASSED`);
        console.log('===============================================================');
        for (const r of summary.results) {
          const badge = r.passed ? '[PASS]' : '[FAIL]';
          console.log(`${badge} ${r.id} (${r.category}): ${r.title} (${r.durationMs}ms)`);
          if (!r.passed) {
            console.error(`       -> ${r.error}`);
          }
        }
        if (summary.failed > 0) {
          process.exit(1);
        }
      })
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
