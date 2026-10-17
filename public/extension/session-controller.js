/**
 * JARVIS Auto-Pilot — Explicit 12-State Session Controller
 * Canonical Manifest V3 Module (session-controller.js)
 *
 * Implements:
 * - Explicit 12-state machine:
 *   IDLE, READY, SUBMITTING, GENERATING, RESPONSE_COMPLETE, CONTINUING,
 *   PAUSED, WAITING_FOR_APPROVAL, INTERRUPTED, ERROR, STOPPED, COMPLETED
 * - Single Unresolved Automated Submission Invariant:
 *   At most one unresolved automated submission may exist in a session.
 * - Canonical Active-Task Rule:
 *   pendingTasks[0].title, currentMilestone, and nextProposedAction are kept strictly synchronized.
 * - Supervised mode (default) & Bounded Autonomous mode
 * - 7-point JARVIS Continuation Policy prompt builder
 * - Structured Markdown + conservative heuristic response parser
 * - Bounded exponential backoff retries, maxTurns, maxRuntimeMs, promptDelayMs
 * - Safe recovery across browser/service-worker restarts
 */
(function (root) {
  'use strict';

  const StorageMod =
    root.JarvisStorage ||
    (typeof require === 'function' ? require('./storage.js') : null);
  const BridgeMod =
    root.JarvisLocalAgentBridge ||
    (typeof require === 'function' ? require('./local-agent-bridge.js') : null);

  const {
    VALID_STATES,
    CONTINUATION_POLICY_RULES,
    computeTextHash,
    generateId,
    sanitizeSecrets,
    synchronizeTaskState,
    resolveCanonicalActiveTask
  } = StorageMod;

  /**
   * Explicit permitted state transitions for the 12-state machine.
   * Note: Any state can transition to STOPPED (Emergency Stop), PAUSED, INTERRUPTED, or ERROR.
   */
  const PERMITTED_TRANSITIONS = Object.freeze({
    IDLE: ['READY', 'WAITING_FOR_APPROVAL', 'PAUSED', 'STOPPED', 'ERROR', 'INTERRUPTED'],
    READY: [
      'WAITING_FOR_APPROVAL',
      'SUBMITTING',
      'PAUSED',
      'INTERRUPTED',
      'ERROR',
      'STOPPED',
      'COMPLETED',
      'IDLE'
    ],
    WAITING_FOR_APPROVAL: [
      'SUBMITTING',
      'READY',
      'PAUSED',
      'INTERRUPTED',
      'ERROR',
      'STOPPED',
      'COMPLETED',
      'IDLE'
    ],
    SUBMITTING: ['GENERATING', 'INTERRUPTED', 'PAUSED', 'ERROR', 'STOPPED'],
    GENERATING: [
      'RESPONSE_COMPLETE',
      'CONTINUING',
      'PAUSED',
      'INTERRUPTED',
      'ERROR',
      'STOPPED'
    ],
    CONTINUING: [
      'GENERATING',
      'READY',
      'WAITING_FOR_APPROVAL',
      'PAUSED',
      'INTERRUPTED',
      'ERROR',
      'STOPPED'
    ],
    RESPONSE_COMPLETE: [
      'CONTINUING',
      'READY',
      'WAITING_FOR_APPROVAL',
      'COMPLETED',
      'PAUSED',
      'INTERRUPTED',
      'ERROR',
      'STOPPED'
    ],
    PAUSED: [
      'READY',
      'WAITING_FOR_APPROVAL',
      'GENERATING',
      'INTERRUPTED',
      'STOPPED',
      'ERROR',
      'IDLE'
    ],
    INTERRUPTED: [
      'READY',
      'WAITING_FOR_APPROVAL',
      'GENERATING',
      'PAUSED',
      'STOPPED',
      'ERROR',
      'IDLE'
    ],
    ERROR: ['READY', 'WAITING_FOR_APPROVAL', 'PAUSED', 'STOPPED', 'IDLE'],
    STOPPED: ['IDLE', 'READY'],
    COMPLETED: ['IDLE', 'READY', 'STOPPED']
  });

  /**
   * Patterns indicating a consequential or destructive action that MUST NEVER be
   * auto-approved without human intervention.
   */
  const CONSEQUENTIAL_ACTION_PATTERNS = [
    /\brm\s+-rf\b/i,
    /\bdel\s+\/[fqs]/i,
    /\bformat\s+[a-z]:/i,
    /\bdrop\s+table\b/i,
    /\bgit\s+push\s+--force\b/i,
    /\bnpm\s+publish\b/i,
    /\bpip\s+upload\b/i,
    /\bdelete\s+production\b/i,
    /\bexpose\s+secret\b/i
  ];

  /**
   * Dual-stage assistant response parser:
   * 1. Looks for structured JARVIS checkpoint headers/fields (`NEXT_MILESTONE:`, `SUMMARY:`, `STATUS:`).
   * 2. Falls back to conservative Markdown heading/bullet extraction.
   * 3. Flags `ambiguous: true` if no clear next milestone or completion signal can be verified.
   */
  function parseAssistantResponse(responseText) {
    const raw = typeof responseText === 'string' ? responseText.trim() : '';
    if (!raw) {
      return {
        summary: '',
        nextMilestone: '',
        filesChanged: 'None (ChatGPT web session only)',
        testsPerformed: 'None executed locally',
        unresolvedRisks: 'Empty response received',
        objectiveComplete: false,
        explicitStopRequest: true,
        requiresHumanIntervention: true,
        consequentialActionDetected: false,
        ambiguous: true
      };
    }

    const consequentialActionDetected = CONSEQUENTIAL_ACTION_PATTERNS.some((rx) =>
      rx.test(raw)
    );

    const extractField = (labels) => {
      for (const label of labels) {
        const regex = new RegExp(
          `(?:^|\\n)\\s*(?:[-*]|#{1,4}|\\d+\\.)?\\s*\\**${label}\\**\\s*[:\\-]\\s*([^\\n]+)`,
          'i'
        );
        const match = raw.match(regex);
        if (match && match[1] && match[1].trim()) {
          return sanitizeSecrets(match[1].trim());
        }
      }
      return '';
    };

    const summaryField = extractField([
      'Summary',
      'Progress Summary',
      'Completed Work',
      'Response Summary'
    ]);
    const nextMilestoneField = extractField([
      'Next Proposed Milestone',
      'Next Milestone',
      'Next Action',
      'Next Task',
      'Proposed Next Step'
    ]);
    const filesField = extractField(['Files Changed', 'Files Modified', 'Affected Files']);
    const testsField = extractField(['Tests Performed', 'Verification', 'Tests']);
    const risksField = extractField(['Unresolved Risks', 'Risks', 'Open Risks']);
    const statusField = extractField(['Session Status', 'Objective Status', 'Status']);

    // Check explicit completion markers
    const objectiveComplete =
      /\bOBJECTIVE_COMPLETE\b/i.test(raw) ||
      /\bALL_MILESTONES_COMPLETE\b/i.test(raw) ||
      /\b(?:completed|finished)\s+all\s+planned\s+milestones\b/i.test(statusField);

    // Check explicit intervention request from assistant
    const explicitStopRequest =
      /\bREQUEST_HUMAN_INTERVENTION\b/i.test(raw) ||
      /\bAMBIGUOUS_PROJECT_STATE\b/i.test(raw) ||
      /\bstop and request intervention\b/i.test(raw.toLowerCase());

    // Heuristic fallback for summary (first meaningful paragraph)
    let summary = summaryField;
    if (!summary) {
      const paragraphs = raw
        .split(/\n{2,}/)
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter((p) => p.length > 20 && !p.startsWith('```'));
      summary =
        paragraphs.length > 0
          ? sanitizeSecrets(paragraphs[0].slice(0, 280))
          : sanitizeSecrets(raw.slice(0, 200));
    }

    // Heuristic fallback for nextMilestone (look beneath a "Next Milestone" / "Next Steps" section)
    let nextMilestone = nextMilestoneField;
    if (!nextMilestone && !objectiveComplete) {
      const sectionMatch = raw.match(
        /(?:next\s+proposed\s+milestone|next\s+milestone|next\s+step[s]?)\s*[:\n]+(?:\s*[-*1.]+\s*)([^\n]+)/i
      );
      if (sectionMatch && sectionMatch[1]) {
        nextMilestone = sanitizeSecrets(sectionMatch[1].trim());
      }
    }

    if (/^OBJECTIVE_COMPLETE$/i.test(nextMilestone)) {
      nextMilestone = '';
    }

    const hasValidNextMilestone =
      Boolean(nextMilestone) &&
      nextMilestone.length >= 8 &&
      !/\b(?:tbd|unknown|unclear|not sure)\b/i.test(nextMilestone);

    const ambiguous =
      explicitStopRequest ||
      consequentialActionDetected ||
      (!objectiveComplete && !hasValidNextMilestone);

    return {
      summary,
      nextMilestone: hasValidNextMilestone ? nextMilestone : '',
      filesChanged: filesField || 'None directly modified (ChatGPT web advisor mode)',
      testsPerformed: testsField || 'Pending local Windows 11 execution',
      unresolvedRisks: risksField || 'None reported in turn',
      objectiveComplete,
      explicitStopRequest,
      requiresHumanIntervention:
        explicitStopRequest || consequentialActionDetected || ambiguous,
      consequentialActionDetected,
      ambiguous
    };
  }

  /**
   * Builds the deterministic JARVIS Auto-Pilot prompt adhering strictly to the
   * Canonical Active-Task Rule, 7-point continuation policy, and anti-hallucination constraints.
   */
  function buildContinuationPrompt(checkpoint, turnId) {
    // Synchronize task state before building prompt so currentMilestone, pendingTasks[0], and nextProposedAction agree
    synchronizeTaskState(checkpoint);
    const activeMilestone =
      resolveCanonicalActiveTask(checkpoint) ||
      'Review current JARVIS objective and propose the next concrete milestone.';

    const completedList =
      checkpoint.completedTasks && checkpoint.completedTasks.length > 0
        ? checkpoint.completedTasks
            .slice(-5)
            .map((t, i) => `  ${i + 1}. [DONE] ${t.title} (${t.evidence || 'Verified'})`)
            .join('\n')
        : '  (No milestones marked complete yet in this session)';

    const pendingList =
      checkpoint.pendingTasks && checkpoint.pendingTasks.length > 0
        ? checkpoint.pendingTasks
            .slice(0, 5)
            .map((t, i) => `  ${i + 1}. [PENDING] ${t.title}`)
            .join('\n')
        : `  1. [PENDING] ${activeMilestone}`;

    const lines = [
      `[JARVIS AUTO-PILOT TURN: ${turnId} | SESSION: ${checkpoint.sessionId} | TURN ${checkpoint.turnCount + 1}/${checkpoint.maxTurns}]`,
      '',
      '=== PROJECT OBJECTIVE ===',
      checkpoint.projectObjective,
      '',
      '=== PINNED PROJECT CONTEXT (INITIAL CONTEXT — DO NOT INVENT UNVERIFIED REPO STATE) ===',
      checkpoint.projectContext,
      '',
      '=== LATEST CHECKPOINT STATE ===',
      `- Last Response Summary: ${checkpoint.lastResponseSummary || 'Initial session turn (no prior response).'}`,
      `- Active Milestone Target: ${activeMilestone}`,
      '- Completed Milestones:',
      completedList,
      '- Pending Milestones:',
      pendingList,
      '',
      '=== MANDATORY CONTINUATION POLICY ===',
      ...CONTINUATION_POLICY_RULES,
      '',
      'IMPORTANT EXECUTION BOUNDARY:',
      'This browser extension does NOT grant ChatGPT direct access to the local Windows 11 filesystem or local test runner. Do NOT claim that you modified local files or executed pytest unless output was explicitly pasted above.',
      '',
      'Please format the end of your response with these exact checkpoint lines so JARVIS Auto-Pilot can record verified progress:',
      'Summary: <1-2 sentence evidence-backed summary of work completed in this turn>',
      'Files Changed: <Proposed file paths or "None (design/specification only)">',
      'Tests Performed: <Verification steps or local commands for the operator to run>',
      'Unresolved Risks: <Any architectural or safety risks>',
      'Next Proposed Milestone: <Single concrete, well-defined next task, or OBJECTIVE_COMPLETE if finished>'
    ];

    return lines.join('\n');
  }

  class SessionController {
    constructor(options) {
      const opts = options || {};
      this.storage = opts.storage || new StorageMod.JarvisStorageEngine();
      this.domAdapter = opts.domAdapter || null;
      this.agentBridge =
        opts.agentBridge ||
        (BridgeMod ? new BridgeMod.LocalAgentBridge() : null);
      this.nowFn = opts.nowFn || (() => Date.now());
    }

    setDomAdapter(adapter) {
      this.domAdapter = adapter;
    }

    isTransitionPermitted(fromState, toState) {
      if (!VALID_STATES.includes(fromState) || !VALID_STATES.includes(toState)) {
        return false;
      }
      if (fromState === toState) return true;
      const allowed = PERMITTED_TRANSITIONS[fromState] || [];
      return allowed.includes(toState);
    }

    /**
     * Computes bounded exponential backoff in milliseconds.
     * Delay = baseMs * 2^(retryAttempt - 1), capped at 60,000ms.
     */
    computeBackoffDelayMs(retryAttempt, baseMs) {
      const base = Math.max(500, Number(baseMs || 2000));
      const exp = Math.max(0, Number(retryAttempt || 1) - 1);
      return Math.min(60000, base * Math.pow(2, exp));
    }

    _appendLog(checkpoint, level, message, stateOverride) {
      const now = this.nowFn();
      const targetState = stateOverride || checkpoint.state;
      checkpoint.activityLog.unshift({
        id: generateId('log'),
        timestamp: now,
        level,
        state: targetState,
        message: sanitizeSecrets(message)
      });
      if (checkpoint.activityLog.length > 100) {
        checkpoint.activityLog = checkpoint.activityLog.slice(0, 100);
      }
    }

    _recordError(checkpoint, code, message, recoverable = true) {
      const now = this.nowFn();
      const cleanMsg = sanitizeSecrets(message);
      const errObj = {
        id: generateId('err'),
        timestamp: now,
        code,
        message: cleanMsg,
        recoverable
      };
      checkpoint.lastError = errObj;
      checkpoint.errors.unshift(errObj);
      if (checkpoint.errors.length > 50) {
        checkpoint.errors = checkpoint.errors.slice(0, 50);
      }
      this._appendLog(checkpoint, 'ERROR', `[${code}] ${cleanMsg}`);
    }

    /**
     * Persists a validated state transition before proceeding to the next action.
     */
    async transitionState(checkpoint, nextState, reason) {
      const currentState = checkpoint.state;
      if (!this.isTransitionPermitted(currentState, nextState)) {
        throw new Error(
          `Illegal state transition attempted: ${currentState} -> ${nextState}`
        );
      }
      checkpoint.state = nextState;
      this._appendLog(
        checkpoint,
        nextState === 'ERROR' || nextState === 'STOPPED'
          ? 'ERROR'
          : nextState === 'INTERRUPTED' || nextState === 'PAUSED'
          ? 'WARN'
          : 'INFO',
        reason || `Transitioned ${currentState} -> ${nextState}`,
        nextState
      );
      return await this.storage.saveCheckpoint(
        checkpoint,
        reason || `State -> ${nextState}`
      );
    }

    /**
     * Starts or initializes a session from IDLE, STOPPED, or COMPLETED.
     * Synchronizes any configuration overrides using saveConfiguration so
     * currentMilestone, pendingTasks[0], nextProposedAction, and stagedPrompt
     * always match the saved, current configuration.
     */
    async startSession(configOverrides) {
      let cp = await this.storage.loadCheckpoint();
      const now = this.nowFn();

      // Guardrail: Never start if an unresolved submission already exists
      if (cp.unresolvedSubmission) {
        this._recordError(
          cp,
          'UNRESOLVED_SUBMISSION_LOCK',
          'Cannot start session while an unresolved submission exists. Verify or resolve manual recovery first.'
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Blocked start due to unresolved submission invariant.'
        );
      }

      if (configOverrides && typeof configOverrides === 'object' && Object.keys(configOverrides).length > 0) {
        cp = await this.storage.saveConfiguration(
          configOverrides,
          'Synchronized session configuration before start.'
        );
      } else {
        synchronizeTaskState(cp);
      }

      cp.timestamps.sessionStartedAt = cp.timestamps.sessionStartedAt || now;
      cp.lastError = null;
      cp.retryCount = 0;
      cp.nextRetryAt = null;

      if (this.domAdapter) {
        cp.conversationUrl = this.domAdapter.getConversationUrl();
      }

      await this.transitionState(cp, 'READY', `Session started in ${cp.operationMode} mode.`);

      const nextTurnId = generateId('turn');
      cp.currentTurnId = nextTurnId;
      cp.stagedPrompt = buildContinuationPrompt(cp, nextTurnId);

      if (cp.operationMode === 'SUPERVISED') {
        return await this.transitionState(
          cp,
          'WAITING_FOR_APPROVAL',
          'Staged prompt in Supervised Mode; awaiting operator approval.'
        );
      }

      return await this.storage.saveCheckpoint(
        cp,
        'Session READY in Bounded Autonomous Mode.'
      );
    }

    /**
     * Immediate Emergency Stop from ANY state.
     * Prevents any future automated submissions until explicitly reset.
     */
    async emergencyStop(reason) {
      const cp = await this.storage.loadCheckpoint();
      const stopMsg = reason || 'Emergency Stop activated by operator.';
      cp.nextRetryAt = null;
      cp.nextAllowedSubmissionAt = null;
      this._recordError(cp, 'EMERGENCY_STOP', stopMsg, false);
      return await this.transitionState(cp, 'STOPPED', stopMsg);
    }

    async pauseSession(reason) {
      const cp = await this.storage.loadCheckpoint();
      if (cp.state === 'STOPPED' || cp.state === 'COMPLETED') {
        return cp;
      }
      return await this.transitionState(
        cp,
        'PAUSED',
        reason || 'Session paused by operator.'
      );
    }

    async resumeSession() {
      const cp = await this.storage.loadCheckpoint();
      if (cp.state !== 'PAUSED' && cp.state !== 'INTERRUPTED' && cp.state !== 'ERROR') {
        return cp;
      }

      // If an unresolved submission exists, verify whether it landed in the DOM before resuming
      if (cp.unresolvedSubmission) {
        if (this.domAdapter) {
          const check = this.domAdapter.verifySubmission(
            cp.unresolvedSubmission.promptHash,
            cp.unresolvedSubmission.turnId
          );
          if (check.verified) {
            cp.unresolvedSubmission.verifiedInDom = true;
            cp.lastSubmittedPrompt = cp.unresolvedSubmission.promptText;
            cp.unresolvedSubmission = null;
            cp.lastError = null;
            return await this.transitionState(
              cp,
              'GENERATING',
              'Verified previously unresolved submission in DOM; resumed to GENERATING.'
            );
          }
        }
        this._recordError(
          cp,
          'AMBIGUOUS_SUBMISSION_ON_RESUME',
          'Previous submission status remains ambiguous. Confirm manually before continuing.'
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Cannot resume automatically while submission status is ambiguous.'
        );
      }

      cp.lastError = null;
      cp.retryCount = 0;
      cp.nextRetryAt = null;
      synchronizeTaskState(cp);

      if (cp.operationMode === 'SUPERVISED') {
        const turnId = cp.currentTurnId || generateId('turn');
        cp.currentTurnId = turnId;
        cp.stagedPrompt = buildContinuationPrompt(cp, turnId);
        return await this.transitionState(
          cp,
          'WAITING_FOR_APPROVAL',
          'Session resumed to WAITING_FOR_APPROVAL.'
        );
      }

      return await this.transitionState(cp, 'READY', 'Session resumed to READY.');
    }

    /**
     * Explicit operator resolution for an ambiguous submission after browser restart or timeout.
     * @param {'CONFIRMED_SENT' | 'CONFIRMED_NOT_SENT'} resolution
     */
    async resolveAmbiguousSubmission(resolution) {
      const cp = await this.storage.loadCheckpoint();
      const now = this.nowFn();

      if (resolution === 'CONFIRMED_SENT') {
        if (cp.unresolvedSubmission) {
          cp.lastSubmittedPrompt = cp.unresolvedSubmission.promptText;
          cp.turnCount += 1;
          cp.unresolvedSubmission = null;
        }
        cp.lastError = null;
        cp.timestamps.lastSuccessfulActivityAt = now;
        return await this.transitionState(
          cp,
          'GENERATING',
          'Operator confirmed prompt was sent; monitoring response in GENERATING.'
        );
      }

      if (resolution === 'CONFIRMED_NOT_SENT') {
        if (cp.unresolvedSubmission && !cp.stagedPrompt) {
          cp.stagedPrompt = cp.unresolvedSubmission.promptText;
        }
        cp.unresolvedSubmission = null;
        cp.lastError = null;
        const target = cp.operationMode === 'SUPERVISED' ? 'WAITING_FOR_APPROVAL' : 'READY';
        return await this.transitionState(
          cp,
          target,
          `Operator confirmed prompt was NOT sent; cleared lock and returned to ${target}.`
        );
      }

      throw new Error(`Unknown resolution mode: ${String(resolution)}`);
    }

    /**
     * Recovers safely after service worker suspension, extension reload, or browser restart.
     * Never assumes a previously submitted message failed merely because state was reloaded.
     */
    async recoverFromRestart() {
      const cp = await this.storage.loadCheckpoint();

      // If an unresolved submission was recorded or state was left in SUBMITTING:
      if (cp.state === 'SUBMITTING' || cp.unresolvedSubmission) {
        if (this.domAdapter && cp.unresolvedSubmission) {
          const verification = this.domAdapter.verifySubmission(
            cp.unresolvedSubmission.promptHash,
            cp.unresolvedSubmission.turnId
          );
          if (verification.verified) {
            cp.unresolvedSubmission = null;
            cp.turnCount += 1;
            cp.lastError = null;
            return await this.transitionState(
              cp,
              'GENERATING',
              `Recovered after restart: verified turn ${cp.currentTurnId} in ChatGPT DOM.`
            );
          }
        }

        // Ambiguous submission -> Stop and request manual recovery!
        this._recordError(
          cp,
          'AMBIGUOUS_SUBMISSION_RECOVERY',
          'Extension restarted while a prompt submission was unresolved. Stopped to prevent duplicate prompt submission; please confirm whether the message appeared in ChatGPT.'
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Ambiguous submission detected on recovery; awaiting manual confirmation.'
        );
      }

      return cp;
    }

    /**
     * Checks session limits (maxTurns and maxRuntimeMs).
     */
    _checkSessionLimits(cp) {
      const now = this.nowFn();
      if (cp.turnCount >= cp.maxTurns) {
        return {
          exceeded: true,
          code: 'MAX_TURNS_REACHED',
          targetState: 'COMPLETED',
          reason: `Reached configured maximum turns (${cp.turnCount}/${cp.maxTurns}).`
        };
      }

      if (cp.timestamps.sessionStartedAt) {
        const elapsed = now - cp.timestamps.sessionStartedAt;
        if (elapsed >= cp.maxRuntimeMs) {
          return {
            exceeded: true,
            code: 'MAX_RUNTIME_EXCEEDED',
            targetState: 'INTERRUPTED',
            reason: `Reached configured maximum session runtime (${Math.round(elapsed / 60000)}m / ${Math.round(cp.maxRuntimeMs / 60000)}m).`
          };
        }
      }

      return { exceeded: false };
    }

    /**
     * Approves and submits the staged prompt in Supervised Mode (or triggers submission in Ready).
     */
    async approveAndSubmitPrompt(customPromptOverride) {
      let cp = await this.storage.loadCheckpoint();
      if (cp.state === 'STOPPED') {
        throw new Error('Session is STOPPED. Reset or start a new session before submitting.');
      }

      if (cp.state !== 'WAITING_FOR_APPROVAL' && cp.state !== 'READY') {
        throw new Error(
          `Cannot approve submission from state "${cp.state}". Expected WAITING_FOR_APPROVAL or READY.`
        );
      }

      synchronizeTaskState(cp);

      if (typeof customPromptOverride === 'string' && customPromptOverride.trim()) {
        cp.stagedPrompt = sanitizeSecrets(customPromptOverride.trim());
      } else {
        // Ensure the prompt being submitted reflects the current synchronized milestone & queue
        const turnId = cp.currentTurnId || generateId('turn');
        cp.currentTurnId = turnId;
        cp.stagedPrompt = buildContinuationPrompt(cp, turnId);
      }

      return await this._executeSubmission(cp);
    }

    /**
     * Internal submission executor enforcing the Single Unresolved Submission Invariant.
     */
    async _executeSubmission(cp) {
      const now = this.nowFn();

      // INVARIANT CHECK: At most one unresolved automated submission may exist
      if (cp.unresolvedSubmission !== null) {
        this._recordError(
          cp,
          'DUPLICATE_SUBMISSION_BLOCKED',
          `Invariant violation prevented: unresolved submission (${cp.unresolvedSubmission.turnId}) already exists.`
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Blocked duplicate submission while previous turn is unresolved.'
        );
      }

      const limitCheck = this._checkSessionLimits(cp);
      if (limitCheck.exceeded) {
        if (limitCheck.targetState === 'INTERRUPTED') {
          this._recordError(cp, limitCheck.code, limitCheck.reason);
        }
        return await this.transitionState(cp, limitCheck.targetState, limitCheck.reason);
      }

      if (!this.domAdapter) {
        this._recordError(
          cp,
          'DOM_ADAPTER_UNAVAILABLE',
          'No ChatGPT DOM adapter is connected. Open chatgpt.com to submit prompts.'
        );
        return await this.transitionState(
          cp,
          'PAUSED',
          'Paused because ChatGPT DOM adapter is not connected.'
        );
      }

      synchronizeTaskState(cp);
      const turnId = cp.currentTurnId || generateId('turn');
      cp.currentTurnId = turnId;
      const promptToSend = cp.stagedPrompt || buildContinuationPrompt(cp, turnId);
      const promptHash = computeTextHash(promptToSend);

      // Step 1: Persist unresolvedSubmission lock and transition to SUBMITTING BEFORE touching the DOM
      cp.unresolvedSubmission = {
        turnId,
        promptText: promptToSend,
        promptHash,
        submittedAt: now,
        verifiedInDom: false
      };
      cp = await this.transitionState(
        cp,
        'SUBMITTING',
        `Submitting turn ${turnId} (${cp.turnCount + 1}/${cp.maxTurns}).`
      );

      // Step 2: Execute DOM submission
      const submitResult = this.domAdapter.submitPrompt(promptToSend, cp.conversationUrl);

      if (!submitResult.ok) {
        const preClickSafeCodes = [
          'EMPTY_PROMPT',
          'COMPOSER_NOT_FOUND',
          'SEND_BUTTON_NOT_FOUND',
          'SEND_BUTTON_DISABLED',
          'GENERATION_ALREADY_ACTIVE',
          'CONVERSATION_URL_MISMATCH'
        ];

        if (preClickSafeCodes.includes(submitResult.code)) {
          cp.unresolvedSubmission = null;
          return await this._handleRecoverableFailure(
            cp,
            submitResult.code,
            submitResult.reason
          );
        }

        cp.unresolvedSubmission = null;
        this._recordError(cp, submitResult.code, submitResult.reason);
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          `Submission halted due to ${submitResult.code}: ${submitResult.reason}`
        );
      }

      // Step 3: Verify that the submitted message appeared in the intended conversation DOM
      const verification = this.domAdapter.verifySubmission(promptHash, turnId);
      if (!verification.verified) {
        this._recordError(
          cp,
          'SUBMISSION_VERIFICATION_AMBIGUOUS',
          'Send button was triggered, but the prompt could not be verified in the conversation DOM. Stopping to prevent duplicate submission.'
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Ambiguous submission: could not verify message in DOM after Send.'
        );
      }

      // Step 4: Submission verified! Clear unresolved lock, record turn, transition to GENERATING
      cp.unresolvedSubmission = null;
      cp.lastSubmittedPrompt = promptToSend;
      cp.stagedPrompt = '';
      cp.turnCount += 1;
      cp.continuationCount = 0;
      cp.retryCount = 0;
      cp.nextRetryAt = null;
      cp.timestamps.lastSuccessfulActivityAt = this.nowFn();
      cp.conversationUrl = this.domAdapter.getConversationUrl();

      return await this.transitionState(
        cp,
        'GENERATING',
        `Verified turn ${turnId} in conversation DOM (${verification.matchedBy}); awaiting assistant completion.`
      );
    }

    /**
     * Handles transient errors with bounded retries and exponential backoff.
     */
    async _handleRecoverableFailure(cp, code, reason) {
      const now = this.nowFn();
      cp.retryCount = (cp.retryCount || 0) + 1;

      if (cp.retryCount > cp.maxRetries) {
        this._recordError(
          cp,
          code,
          `Retry limit exhausted (${cp.maxRetries}/${cp.maxRetries}): ${reason}`,
          false
        );
        return await this.transitionState(
          cp,
          'ERROR',
          `Exceeded maximum retries (${cp.maxRetries}) due to ${code}.`
        );
      }

      const delayMs = this.computeBackoffDelayMs(cp.retryCount, cp.backoffBaseMs);
      cp.nextRetryAt = now + delayMs;
      this._recordError(
        cp,
        code,
        `${reason} (Retry ${cp.retryCount}/${cp.maxRetries} scheduled in ${Math.round(delayMs / 1000)}s)`,
        true
      );
      return await this.transitionState(
        cp,
        'PAUSED',
        `Paused for backoff retry ${cp.retryCount}/${cp.maxRetries} (${delayMs}ms).`
      );
    }

    /**
     * Executes a single deterministic orchestration tick.
     * Never submits a prompt merely because a polling interval elapsed.
     */
    async step() {
      let cp = await this.storage.loadCheckpoint();
      const now = this.nowFn();

      if (
        cp.state === 'IDLE' ||
        cp.state === 'STOPPED' ||
        cp.state === 'COMPLETED' ||
        cp.state === 'WAITING_FOR_APPROVAL' ||
        cp.state === 'INTERRUPTED' ||
        cp.state === 'ERROR'
      ) {
        return cp;
      }

      const limitCheck = this._checkSessionLimits(cp);
      if (limitCheck.exceeded && cp.state !== 'GENERATING') {
        if (limitCheck.targetState === 'INTERRUPTED') {
          this._recordError(cp, limitCheck.code, limitCheck.reason);
        }
        return await this.transitionState(cp, limitCheck.targetState, limitCheck.reason);
      }

      if (cp.state === 'PAUSED') {
        if (cp.nextRetryAt && now >= cp.nextRetryAt && !cp.unresolvedSubmission) {
          cp.nextRetryAt = null;
          return await this.transitionState(
            cp,
            'READY',
            `Backoff timer elapsed (attempt ${cp.retryCount}/${cp.maxRetries}); returning to READY.`
          );
        }
        return cp;
      }

      if (cp.state === 'SUBMITTING') {
        return await this.recoverFromRestart();
      }

      if (!this.domAdapter) {
        return cp;
      }

      const observation = this.domAdapter.observePageState();

      if (
        cp.conversationUrl &&
        observation.url &&
        cp.conversationUrl !== observation.url
      ) {
        this._recordError(
          cp,
          'UNEXPECTED_NAVIGATION',
          `Page navigated from "${cp.conversationUrl}" to "${observation.url}".`
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Paused due to unexpected conversation navigation.'
        );
      }

      if (observation.authChallenge && observation.authChallenge.blocked) {
        this._recordError(
          cp,
          observation.authChallenge.code,
          observation.authChallenge.reason
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          observation.authChallenge.reason
        );
      }

      if (observation.errorOrLimit && observation.errorOrLimit.detected) {
        if (observation.errorOrLimit.type === 'RATE_LIMIT') {
          this._recordError(cp, 'RATE_LIMIT', observation.errorOrLimit.message, false);
          return await this.transitionState(
            cp,
            'INTERRUPTED',
            `Rate limit reached: ${observation.errorOrLimit.message}`
          );
        }
        return await this._handleRecoverableFailure(
          cp,
          observation.errorOrLimit.type,
          observation.errorOrLimit.message
        );
      }

      cp.lastObservedResponseState = {
        messageId: observation.latestAssistantMessage
          ? observation.latestAssistantMessage.messageId
          : null,
        textHash: observation.latestAssistantMessage
          ? observation.latestAssistantMessage.textHash
          : null,
        length: observation.latestAssistantMessage
          ? observation.latestAssistantMessage.length
          : 0,
        isStreaming: observation.isGenerating,
        hasContinueButton: observation.hasContinueButton,
        stablePolls: observation.stablePolls,
        observedAt: observation.observedAt
      };

      if (cp.state === 'GENERATING') {
        if (!observation.isGenerating && observation.hasContinueButton) {
          if (cp.continuationCount >= cp.maxContinuationsPerTurn) {
            this._recordError(
              cp,
              'MAX_CONTINUATIONS_EXCEEDED',
              `Assistant response required more than ${cp.maxContinuationsPerTurn} continuations in a single turn. Requesting human review.`
            );
            return await this.transitionState(
              cp,
              'INTERRUPTED',
              'Stopped: maximum Continue generating clicks per turn reached.'
            );
          }

          if (cp.operationMode === 'SUPERVISED') {
            this._recordError(
              cp,
              'CONTINUE_APPROVAL_REQUIRED',
              'Continue generating button detected in Supervised Mode. Please review or click Continue.'
            );
            return await this.transitionState(
              cp,
              'WAITING_FOR_APPROVAL',
              'Awaiting approval to click Continue generating.'
            );
          }

          cp = await this.transitionState(
            cp,
            'CONTINUING',
            `Detected verified Continue generating button (${cp.continuationCount + 1}/${cp.maxContinuationsPerTurn}).`
          );
          const clickRes = this.domAdapter.clickContinueGenerating();
          if (!clickRes.ok) {
            this._recordError(cp, clickRes.code, clickRes.reason);
            return await this.transitionState(cp, 'INTERRUPTED', clickRes.reason);
          }
          cp.continuationCount += 1;
          cp.timestamps.lastSuccessfulActivityAt = now;
          return await this.transitionState(
            cp,
            'GENERATING',
            'Clicked Continue generating; resumed response monitoring.'
          );
        }

        if (observation.isResponseComplete && observation.latestAssistantMessage) {
          cp.timestamps.lastSuccessfulActivityAt = now;
          cp = await this.transitionState(
            cp,
            'RESPONSE_COMPLETE',
            `Assistant response verified complete after ${observation.stablePolls} stable checks.`
          );
          return await this._processCompletedResponse(
            cp,
            observation.latestAssistantMessage.text
          );
        }

        return await this.storage.saveCheckpoint(cp);
      }

      if (cp.state === 'READY') {
        synchronizeTaskState(cp);
        if (cp.operationMode === 'SUPERVISED') {
          const turnId = generateId('turn');
          cp.currentTurnId = turnId;
          cp.stagedPrompt = buildContinuationPrompt(cp, turnId);
          return await this.transitionState(
            cp,
            'WAITING_FOR_APPROVAL',
            'Prompt staged in Supervised Mode; awaiting approval.'
          );
        }

        if (cp.nextAllowedSubmissionAt && now < cp.nextAllowedSubmissionAt) {
          return cp;
        }

        const turnId = cp.currentTurnId || generateId('turn');
        cp.currentTurnId = turnId;
        cp.stagedPrompt = buildContinuationPrompt(cp, turnId);
        return await this._executeSubmission(cp);
      }

      return cp;
    }

    /**
     * Parses completed assistant response, advances the pendingTasks queue reliably without
     * losing or repeating pending items, enforces safety boundaries, and stages the next turn.
     */
    async _processCompletedResponse(cp, assistantText) {
      const now = this.nowFn();
      const parsed = parseAssistantResponse(assistantText);

      cp.lastResponseSummary = parsed.summary;

      if (parsed.consequentialActionDetected) {
        this._recordError(
          cp,
          'CONSEQUENTIAL_ACTION_BLOCKED',
          'Assistant response proposed a destructive or consequential command. Automatic continuation halted for human review.',
          false
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Halted: consequential or destructive operation detected in response.'
        );
      }

      if (parsed.explicitStopRequest) {
        this._recordError(
          cp,
          'AMBIGUOUS_NEXT_TASK',
          'Assistant response explicitly flagged ambiguous project state or requested human intervention.'
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Stopped: assistant requested human intervention.'
        );
      }

      // Identify the canonical active task that just completed
      const completedTitle = resolveCanonicalActiveTask(cp);

      // Remove the completed task from pendingTasks reliably (even if currentMilestone was edited)
      if (Array.isArray(cp.pendingTasks) && cp.pendingTasks.length > 0) {
        let removeIdx = 0;
        if (completedTitle) {
          const matchedIdx = cp.pendingTasks.findIndex(
            (t) => t.title.trim().toLowerCase() === completedTitle.trim().toLowerCase()
          );
          if (matchedIdx !== -1) {
            removeIdx = matchedIdx;
          }
        }
        const [removedTask] = cp.pendingTasks.splice(removeIdx, 1);
        const recordedTitle = completedTitle || (removedTask && removedTask.title) || `Turn ${cp.turnCount}`;
        cp.completedTasks.push({
          id: generateId('done'),
          title: recordedTitle,
          completedAt: now,
          evidence: parsed.summary || 'Completed in Turn ' + cp.turnCount
        });
      } else if (completedTitle) {
        cp.completedTasks.push({
          id: generateId('done'),
          title: completedTitle,
          completedAt: now,
          evidence: parsed.summary || 'Completed in Turn ' + cp.turnCount
        });
      }

      if (this.agentBridge) {
        await this.agentBridge.notifyMilestoneComplete({
          sessionId: cp.sessionId,
          milestone: completedTitle,
          summary: parsed.summary
        });
      }

      // If the response proposed a valid nextMilestone that is not already in pendingTasks or completedTasks:
      if (parsed.nextMilestone && !parsed.objectiveComplete) {
        const candidateLower = parsed.nextMilestone.trim().toLowerCase();
        const alreadyPending = cp.pendingTasks.some(
          (t) => t.title.trim().toLowerCase() === candidateLower
        );
        const alreadyCompleted = cp.completedTasks.some(
          (t) => t.title.trim().toLowerCase() === candidateLower
        );
        if (!alreadyPending && !alreadyCompleted) {
          // Append to pendingTasks so pre-existing queued tasks at the front of pendingTasks
          // advance in order without being skipped or lost!
          cp.pendingTasks.push({
            id: generateId('task'),
            title: parsed.nextMilestone.trim(),
            status: 'pending'
          });
        }
      }

      // Check if objective is explicitly complete OR all pending tasks are finished
      if (parsed.objectiveComplete || cp.pendingTasks.length === 0) {
        if (parsed.objectiveComplete || (!parsed.ambiguous && cp.pendingTasks.length === 0)) {
          cp.pendingTasks = [];
          cp.currentMilestone = 'All planned session milestones completed.';
          cp.nextProposedAction = 'None — session objective complete.';
          cp.stagedPrompt = '';
          return await this.transitionState(
            cp,
            'COMPLETED',
            'Session objective completed successfully.'
          );
        }

        // Queue is empty AND assistant did not provide a valid next milestone -> ambiguous!
        this._recordError(
          cp,
          'AMBIGUOUS_NEXT_TASK',
          'Pending task queue is empty and assistant response did not specify a clear next milestone.'
        );
        return await this.transitionState(
          cp,
          'INTERRUPTED',
          'Stopped: next planned task is ambiguous; human guidance required.'
        );
      }

      // Advance to the new head of the pendingTasks queue and synchronize all fields
      synchronizeTaskState(cp, { preferQueueHead: true });

      // Check if maxTurns or maxRuntime was reached after completing this turn
      const limitCheck = this._checkSessionLimits(cp);
      if (limitCheck.exceeded) {
        if (limitCheck.targetState === 'INTERRUPTED') {
          this._recordError(cp, limitCheck.code, limitCheck.reason);
        }
        return await this.transitionState(cp, limitCheck.targetState, limitCheck.reason);
      }

      // Transition through CONTINUING to prepare next turn
      cp = await this.transitionState(
        cp,
        'CONTINUING',
        `Advancing to next milestone: ${cp.currentMilestone}`
      );

      const nextTurnId = generateId('turn');
      cp.currentTurnId = nextTurnId;
      cp.stagedPrompt = buildContinuationPrompt(cp, nextTurnId);
      cp.nextAllowedSubmissionAt = now + cp.promptDelayMs;

      if (cp.operationMode === 'SUPERVISED') {
        return await this.transitionState(
          cp,
          'WAITING_FOR_APPROVAL',
          'Next turn prompt prepared; waiting for operator approval in Supervised Mode.'
        );
      }

      return await this.transitionState(
        cp,
        'READY',
        `Scheduled next autonomous turn after ${Math.round(cp.promptDelayMs / 1000)}s delay.`
      );
    }
  }

  const exported = {
    PERMITTED_TRANSITIONS,
    CONSEQUENTIAL_ACTION_PATTERNS,
    parseAssistantResponse,
    buildContinuationPrompt,
    SessionController
  };

  root.JarvisSessionController = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
