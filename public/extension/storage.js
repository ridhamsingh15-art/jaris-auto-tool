/**
 * JARVIS Auto-Pilot — Versioned Persistent Storage & Checkpoint Engine
 * Canonical Manifest V3 Module (storage.js)
 *
 * Responsibilities:
 * - Manage versioned checkpoints in chrome.storage.local
 * - Enforce the Canonical Active-Task Rule across currentMilestone, pendingTasks, and nextProposedAction
 * - Validate loaded checkpoint structures conservatively
 * - Strictly validate, preview, and safely commit imported checkpoint JSON (v2 and legacy v1->v2)
 * - Preserve user-saved session configurations across session resets
 * - Redact potential secrets before persisting checkpoints or activity logs
 */
(function (root) {
  'use strict';

  const CURRENT_SCHEMA_VERSION = 2;
  const SUPPORTED_LEGACY_VERSIONS = Object.freeze([1]);
  const STORAGE_KEY_CHECKPOINT = 'jarvis_autopilot_checkpoint';
  const STORAGE_KEY_SETTINGS = 'jarvis_autopilot_settings';

  const VALID_STATES = Object.freeze([
    'IDLE',
    'READY',
    'SUBMITTING',
    'GENERATING',
    'RESPONSE_COMPLETE',
    'CONTINUING',
    'PAUSED',
    'WAITING_FOR_APPROVAL',
    'INTERRUPTED',
    'ERROR',
    'STOPPED',
    'COMPLETED'
  ]);

  const VALID_MODES = Object.freeze(['SUPERVISED', 'AUTONOMOUS']);

  const DEFAULT_JARVIS_OBJECTIVE =
    'Advance Project JARVIS architecture and engineering milestones with verified, evidence-backed increments.';

  const DEFAULT_JARVIS_CONTEXT = [
    'Project Name: JARVIS (Local-first AI engineering assistant developed on Windows 11).',
    'Established Engineering Concerns (Treat as initial context, NOT verified repository state):',
    '- Local-first AI assistance and Python/local LLM tooling.',
    '- Planner–Registry–Executor architecture.',
    '- Capability-based tool execution with risk-based permissions and fail-closed behavior.',
    '- Mission tracking, persistence, and crash recovery.',
    '- Automated testing and verified changes.',
    'Constraint: Never invent current source files, test results, architecture status, or next development milestones. Do not claim ChatGPT modified local files or ran tests unless an authorized local tool actually executed them.'
  ].join('\n');

  const DEFAULT_INITIAL_MILESTONE =
    'M1: Review supplied Project JARVIS context and verify the first engineering milestone.';

  const DEFAULT_PENDING_TASKS = Object.freeze([
    {
      id: 'task_1',
      title: DEFAULT_INITIAL_MILESTONE,
      status: 'pending'
    },
    {
      id: 'task_2',
      title: 'M2: Validate Planner–Registry capability permission boundaries and fail-closed error handling.',
      status: 'pending'
    },
    {
      id: 'task_3',
      title: 'M3: Verify crash recovery state transitions and automated regression test coverage.',
      status: 'pending'
    }
  ]);

  const CONTINUATION_POLICY_RULES = Object.freeze([
    '1. Review the supplied project context and latest checkpoint.',
    '2. Identify the next incomplete and well-defined task.',
    '3. Make only evidence-supported claims about project progress.',
    '4. Work on that task without needlessly repeating previous work.',
    '5. Report files changed, tests performed, failures, and unresolved risks.',
    '6. Specify the next proposed milestone.',
    '7. Stop and request intervention when the project state is ambiguous.'
  ]);

  /**
   * Redacts common secret patterns (API keys, Bearer tokens, private keys) from strings
   * so secrets are never persisted in checkpoints or activity logs.
   */
  function sanitizeSecrets(input) {
    if (typeof input !== 'string') return '';
    return input
      .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
      .replace(/AIza[0-9A-Za-z-_]{30,}/g, '[REDACTED_GOOGLE_KEY]')
      .replace(/ghp_[0-9A-Za-z]{30,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED_TOKEN]');
  }

  /**
   * Computes a deterministic FNV-1a 32-bit hex fingerprint for prompt deduplication
   * and response stability checking.
   */
  function computeTextHash(text) {
    const str = typeof text === 'string' ? text.trim() : '';
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'fnv1a_' + hash.toString(16).padStart(8, '0');
  }

  function generateId(prefix) {
    const rand = Math.random().toString(36).substring(2, 10);
    return `${prefix}_${Date.now()}_${rand}`;
  }

  /**
   * Normalizes a list of pending tasks (strings or task objects) into clean task objects
   * while removing blank entries.
   */
  function normalizePendingTasksList(rawTasks) {
    if (!Array.isArray(rawTasks)) return [];
    const normalized = [];
    for (let i = 0; i < rawTasks.length; i++) {
      const item = rawTasks[i];
      const rawTitle =
        typeof item === 'string'
          ? item
          : item && typeof item.title === 'string'
          ? item.title
          : '';
      const cleanTitle = sanitizeSecrets(rawTitle.trim());
      if (!cleanTitle) continue;
      normalized.push({
        id: String((item && item.id) || `task_${normalized.length + 1}`),
        title: cleanTitle,
        status: 'pending'
      });
    }
    return normalized;
  }

  /**
   * CANONICAL ACTIVE-TASK RULE:
   * 1. The active task is the head of `pendingTasks` (`pendingTasks[0].title`) when `pendingTasks` is non-empty,
   *    synchronized with `currentMilestone`.
   * 2. When saving or updating configuration:
   *    - If `options.preferMilestone` is true (e.g. operator edited `currentMilestone` directly),
   *      `currentMilestone` becomes the canonical active task and `pendingTasks[0]` is updated or inserted
   *      so `pendingTasks[0].title === currentMilestone`.
   *    - If `options.preferQueueHead` is true (e.g. operator replaced the `pendingTasks` queue without
   *      changing `currentMilestone` to a new custom value), `pendingTasks[0].title` becomes `currentMilestone`.
   *    - In default normalization, if `pendingTasks` is non-empty and `currentMilestone` is empty,
   *      `currentMilestone` adopts `pendingTasks[0].title`. If `currentMilestone` is non-empty and differs
   *      from `pendingTasks[0].title`: if `currentMilestone` exists later in `pendingTasks`, it is promoted to index 0;
   *      otherwise `pendingTasks[0].title` is synchronized with `currentMilestone`.
   * 3. `nextProposedAction` is ALWAYS derived from the canonical active task (`currentMilestone`),
   *    or `'None — session objective complete.'` when `state === 'COMPLETED'`. It never holds a stale independent string.
   */
  function synchronizeTaskState(checkpoint, syncOptions) {
    if (!checkpoint || typeof checkpoint !== 'object') return checkpoint;
    const opts = syncOptions || {};

    const tasks = normalizePendingTasksList(checkpoint.pendingTasks);
    let milestone = sanitizeSecrets(
      typeof checkpoint.currentMilestone === 'string' ? checkpoint.currentMilestone.trim() : ''
    );

    if (checkpoint.state === 'COMPLETED' && tasks.length === 0) {
      checkpoint.pendingTasks = [];
      checkpoint.currentMilestone =
        milestone || 'All planned session milestones completed.';
      checkpoint.nextProposedAction = 'None — session objective complete.';
      return checkpoint;
    }

    if (opts.preferQueueHead && tasks.length > 0) {
      milestone = tasks[0].title;
    } else if (opts.preferMilestone && milestone) {
      const existingIdx = tasks.findIndex(
        (t) => t.title.toLowerCase() === milestone.toLowerCase()
      );
      if (existingIdx > 0) {
        const [matched] = tasks.splice(existingIdx, 1);
        matched.title = milestone;
        tasks.unshift(matched);
      } else if (tasks.length > 0) {
        tasks[0].title = milestone;
      } else {
        tasks.push({
          id: generateId('task'),
          title: milestone,
          status: 'pending'
        });
      }
    } else {
      if (tasks.length > 0 && !milestone) {
        milestone = tasks[0].title;
      } else if (milestone && tasks.length === 0) {
        tasks.push({
          id: generateId('task'),
          title: milestone,
          status: 'pending'
        });
      } else if (milestone && tasks.length > 0 && tasks[0].title !== milestone) {
        const existingIdx = tasks.findIndex(
          (t) => t.title.toLowerCase() === milestone.toLowerCase()
        );
        if (existingIdx > 0) {
          const [matched] = tasks.splice(existingIdx, 1);
          matched.title = milestone;
          tasks.unshift(matched);
        } else {
          tasks[0].title = milestone;
        }
      }
    }

    checkpoint.pendingTasks = tasks;
    checkpoint.currentMilestone = milestone;
    checkpoint.nextProposedAction = milestone || '';

    return checkpoint;
  }

  /**
   * Returns the canonical active task string for a checkpoint.
   */
  function resolveCanonicalActiveTask(checkpoint) {
    if (!checkpoint || typeof checkpoint !== 'object') return '';
    if (checkpoint.state === 'COMPLETED') {
      return 'None — session objective complete.';
    }
    if (
      Array.isArray(checkpoint.pendingTasks) &&
      checkpoint.pendingTasks.length > 0 &&
      checkpoint.pendingTasks[0] &&
      typeof checkpoint.pendingTasks[0].title === 'string' &&
      checkpoint.pendingTasks[0].title.trim()
    ) {
      return checkpoint.pendingTasks[0].title.trim();
    }
    if (typeof checkpoint.currentMilestone === 'string' && checkpoint.currentMilestone.trim()) {
      return checkpoint.currentMilestone.trim();
    }
    return '';
  }

  /**
   * Extracts the reusable user configuration profile from a checkpoint so session resets
   * preserve the user's saved objective, context, tasks, and limits.
   */
  function extractConfigProfile(checkpoint) {
    return {
      operationMode: VALID_MODES.includes(checkpoint.operationMode)
        ? checkpoint.operationMode
        : 'SUPERVISED',
      projectObjective: checkpoint.projectObjective,
      projectContext: checkpoint.projectContext,
      currentMilestone: checkpoint.currentMilestone,
      nextProposedAction: checkpoint.nextProposedAction,
      pendingTasks: JSON.parse(JSON.stringify(checkpoint.pendingTasks || [])),
      maxTurns: checkpoint.maxTurns,
      maxRuntimeMs: checkpoint.maxRuntimeMs,
      promptDelayMs: checkpoint.promptDelayMs,
      maxContinuationsPerTurn: checkpoint.maxContinuationsPerTurn,
      maxRetries: checkpoint.maxRetries,
      backoffBaseMs: checkpoint.backoffBaseMs,
      wakeLockEnabled: Boolean(checkpoint.wakeLockEnabled)
    };
  }

  /**
   * Creates a fresh, valid Schema v2 checkpoint.
   */
  function createDefaultCheckpoint(overrides) {
    const now = Date.now();
    const initialTasks = JSON.parse(JSON.stringify(DEFAULT_PENDING_TASKS));
    const base = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sessionId: generateId('jarvis_sess'),
      state: 'IDLE',
      operationMode: 'SUPERVISED', // Default to Supervised Mode per requirement
      projectObjective: DEFAULT_JARVIS_OBJECTIVE,
      projectContext: DEFAULT_JARVIS_CONTEXT,
      currentMilestone: initialTasks[0].title,
      nextProposedAction: initialTasks[0].title,
      pendingTasks: initialTasks,
      completedTasks: [],
      lastSubmittedPrompt: '',
      currentTurnId: null,
      unresolvedSubmission: null, // CRITICAL INVARIANT: Non-null when a prompt is in-flight or unverified
      lastObservedResponseState: {
        messageId: null,
        textHash: null,
        length: 0,
        isStreaming: false,
        hasContinueButton: false,
        stablePolls: 0,
        observedAt: null
      },
      lastResponseSummary: '',
      stagedPrompt: '',
      turnCount: 0,
      maxTurns: 8,
      maxRuntimeMs: 120 * 60 * 1000, // 2 hours default
      promptDelayMs: 5000, // Minimum 5s between consecutive prompts
      continuationCount: 0,
      maxContinuationsPerTurn: 2,
      retryCount: 0,
      maxRetries: 3,
      backoffBaseMs: 2000,
      nextRetryAt: null,
      nextAllowedSubmissionAt: null,
      conversationUrl: null,
      wakeLockEnabled: false,
      localAgentBridgeConfig: {
        mode: 'NONE',
        endpoint: ''
      },
      timestamps: {
        createdAt: now,
        sessionStartedAt: null,
        lastUpdatedAt: now,
        lastSuccessfulActivityAt: null,
        lastCheckpointAt: now
      },
      errors: [],
      lastError: null,
      lastSuccessfulCheckpointSummary: 'Initial v2 checkpoint created.',
      activityLog: [
        {
          id: generateId('log'),
          timestamp: now,
          level: 'INFO',
          state: 'IDLE',
          message: 'Initialized JARVIS Auto-Pilot checkpoint (Schema v2, Supervised Mode).'
        }
      ]
    };

    if (overrides && typeof overrides === 'object') {
      const merged = Object.assign({}, base, overrides);
      return validateAndNormalizeCheckpoint(merged, {
        preferQueueHead: Boolean(
          Array.isArray(overrides.pendingTasks) &&
            overrides.pendingTasks.length > 0 &&
            !overrides.currentMilestone
        ),
        preferMilestone: Boolean(overrides.currentMilestone && !overrides.pendingTasks)
      });
    }
    return synchronizeTaskState(base);
  }

  /**
   * Migrates legacy v1 checkpoints to Schema v2.
   * Rejects unsupported future schema versions (> CURRENT_SCHEMA_VERSION).
   */
  function migrateCheckpoint(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid checkpoint: root value must be a JSON object.');
    }

    const rawVersion = raw.schemaVersion !== undefined ? raw.schemaVersion : raw.version;
    const version = rawVersion !== undefined ? Number(rawVersion) : 1;

    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `Invalid schemaVersion "${String(rawVersion)}": must be a positive integer (1 or ${CURRENT_SCHEMA_VERSION}).`
      );
    }

    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported future schemaVersion "${version}". This extension supports up to Schema v${CURRENT_SCHEMA_VERSION}.`
      );
    }

    if (version === CURRENT_SCHEMA_VERSION) {
      return raw;
    }

    const now = Date.now();
    const migratedPending = normalizePendingTasksList(raw.pendingTasks);

    const migratedCompleted = Array.isArray(raw.completedTasks)
      ? raw.completedTasks.map((item, idx) =>
          typeof item === 'string'
            ? {
                id: `migrated_done_${idx + 1}`,
                title: sanitizeSecrets(item),
                completedAt: raw.updatedAt || now,
                evidence: 'Migrated from v1 checkpoint'
              }
            : {
                id: String(item.id || `migrated_done_${idx + 1}`),
                title: sanitizeSecrets(String(item.title || '')),
                completedAt: Number(item.completedAt || now),
                evidence: sanitizeSecrets(String(item.evidence || 'Migrated from v1'))
              }
        )
      : [];

    let unresolvedSubmission = null;
    if (raw.unresolvedSubmission && typeof raw.unresolvedSubmission === 'object') {
      unresolvedSubmission = {
        turnId: String(raw.unresolvedSubmission.turnId || raw.turnId || generateId('turn')),
        promptText: sanitizeSecrets(String(raw.unresolvedSubmission.promptText || raw.lastPrompt || '')),
        promptHash: String(
          raw.unresolvedSubmission.promptHash ||
            computeTextHash(String(raw.unresolvedSubmission.promptText || raw.lastPrompt || ''))
        ),
        submittedAt: Number(raw.unresolvedSubmission.submittedAt || now),
        verifiedInDom: Boolean(raw.unresolvedSubmission.verifiedInDom)
      };
    } else if (raw.inFlightPrompt || raw.state === 'SUBMITTING') {
      const promptStr = sanitizeSecrets(String(raw.inFlightPrompt || raw.lastPrompt || ''));
      unresolvedSubmission = {
        turnId: String(raw.turnId || generateId('turn_v1')),
        promptText: promptStr,
        promptHash: computeTextHash(promptStr),
        submittedAt: Number(raw.updatedAt || now),
        verifiedInDom: false
      };
    }

    const rawMilestone = sanitizeSecrets(
      String(raw.currentMilestone || raw.milestone || (migratedPending[0] && migratedPending[0].title) || '')
    );

    const v2 = createDefaultCheckpoint({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sessionId: String(raw.sessionId || generateId('jarvis_sess')),
      state: VALID_STATES.includes(raw.state) ? raw.state : 'IDLE',
      operationMode: VALID_MODES.includes(raw.operationMode || raw.mode)
        ? raw.operationMode || raw.mode
        : 'SUPERVISED',
      projectObjective: sanitizeSecrets(
        String(raw.projectObjective || raw.objective || 'Migrated JARVIS Engineering Objective')
      ),
      projectContext: sanitizeSecrets(String(raw.projectContext || raw.context || DEFAULT_JARVIS_CONTEXT)),
      currentMilestone: rawMilestone,
      nextProposedAction: rawMilestone,
      pendingTasks: migratedPending,
      completedTasks: migratedCompleted,
      lastSubmittedPrompt: sanitizeSecrets(String(raw.lastSubmittedPrompt || raw.lastPrompt || '')),
      currentTurnId: raw.currentTurnId || raw.turnId || null,
      unresolvedSubmission: unresolvedSubmission,
      lastResponseSummary: sanitizeSecrets(String(raw.lastResponseSummary || raw.summary || '')),
      turnCount: Math.max(0, Number(raw.turnCount || raw.turns || 0)),
      maxTurns: Math.max(1, Number(raw.maxTurns || 8)),
      maxRuntimeMs: Math.max(60000, Number(raw.maxRuntimeMs || 7200000)),
      promptDelayMs: Math.max(1000, Number(raw.promptDelayMs || raw.delayMs || 5000)),
      retryCount: Math.max(0, Number(raw.retryCount || 0)),
      maxRetries: Math.max(1, Number(raw.maxRetries || 3)),
      timestamps: {
        createdAt: Number((raw.timestamps && raw.timestamps.createdAt) || raw.createdAt || now),
        sessionStartedAt:
          (raw.timestamps && raw.timestamps.sessionStartedAt) || raw.sessionStartedAt || null,
        lastUpdatedAt: now,
        lastSuccessfulActivityAt:
          (raw.timestamps && raw.timestamps.lastSuccessfulActivityAt) || raw.lastActivityAt || null,
        lastCheckpointAt: now
      },
      lastSuccessfulCheckpointSummary: `Migrated checkpoint from Schema v${version} to v${CURRENT_SCHEMA_VERSION}.`
    });

    v2.activityLog.unshift({
      id: generateId('log'),
      timestamp: now,
      level: 'INFO',
      state: v2.state,
      message: `Migrated checkpoint schema from v${version} to v${CURRENT_SCHEMA_VERSION}.`
    });

    return v2;
  }

  /**
   * Validates and normalizes any checkpoint object, repairing missing non-critical fields,
   * synchronizing currentMilestone, pendingTasks, and nextProposedAction, and failing closed
   * to INTERRUPTED if critical state invariants are corrupted.
   */
  function validateAndNormalizeCheckpoint(candidate, syncOptions) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Invalid checkpoint: root value must be a JSON object.');
    }

    const rawVersion =
      candidate.schemaVersion !== undefined ? candidate.schemaVersion : candidate.version;
    if (rawVersion !== undefined) {
      const numVer = Number(rawVersion);
      if (!Number.isInteger(numVer) || numVer < 1) {
        throw new Error(`Invalid schemaVersion "${String(rawVersion)}".`);
      }
      if (numVer > CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `Unsupported future schemaVersion "${numVer}". Maximum supported version is ${CURRENT_SCHEMA_VERSION}.`
        );
      }
    }

    let data = candidate;
    if (!data.schemaVersion || Number(data.schemaVersion) < CURRENT_SCHEMA_VERSION) {
      data = migrateCheckpoint(data);
    }

    const now = Date.now();
    const normalizedState = VALID_STATES.includes(data.state) ? data.state : 'INTERRUPTED';
    const normalizedMode = VALID_MODES.includes(data.operationMode) ? data.operationMode : 'SUPERVISED';

    let unresolvedSubmission = null;
    if (data.unresolvedSubmission && typeof data.unresolvedSubmission === 'object') {
      const pText = sanitizeSecrets(String(data.unresolvedSubmission.promptText || ''));
      unresolvedSubmission = {
        turnId: String(data.unresolvedSubmission.turnId || generateId('turn')),
        promptText: pText,
        promptHash: String(data.unresolvedSubmission.promptHash || computeTextHash(pText)),
        submittedAt: Number(data.unresolvedSubmission.submittedAt || now),
        verifiedInDom: Boolean(data.unresolvedSubmission.verifiedInDom)
      };
    }

    const lastObs =
      data.lastObservedResponseState && typeof data.lastObservedResponseState === 'object'
        ? data.lastObservedResponseState
        : {};

    const timestamps =
      data.timestamps && typeof data.timestamps === 'object' ? data.timestamps : {};

    const hasExplicitPending = Array.isArray(data.pendingTasks);
    const pendingList = hasExplicitPending
      ? normalizePendingTasksList(data.pendingTasks)
      : JSON.parse(JSON.stringify(DEFAULT_PENDING_TASKS));

    const hasExplicitMilestone = typeof data.currentMilestone === 'string';
    const rawMilestone = hasExplicitMilestone
      ? sanitizeSecrets(data.currentMilestone.trim())
      : pendingList[0]
      ? pendingList[0].title
      : '';

    const validated = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sessionId: String(data.sessionId || generateId('jarvis_sess')),
      state: normalizedState,
      operationMode: normalizedMode,
      projectObjective: sanitizeSecrets(
        typeof data.projectObjective === 'string' && data.projectObjective.trim()
          ? data.projectObjective.trim()
          : DEFAULT_JARVIS_OBJECTIVE
      ),
      projectContext: sanitizeSecrets(
        typeof data.projectContext === 'string' && data.projectContext.trim()
          ? data.projectContext.trim()
          : DEFAULT_JARVIS_CONTEXT
      ),
      currentMilestone: rawMilestone,
      nextProposedAction: rawMilestone,
      pendingTasks: pendingList,
      completedTasks: Array.isArray(data.completedTasks)
        ? data.completedTasks.map((t, i) => ({
            id: String((t && t.id) || `done_${i + 1}`),
            title: sanitizeSecrets(String((t && t.title) || t || '')),
            completedAt: Number((t && t.completedAt) || now),
            evidence: sanitizeSecrets(String((t && t.evidence) || 'Verified in session'))
          }))
        : [],
      lastSubmittedPrompt: sanitizeSecrets(String(data.lastSubmittedPrompt || '')),
      currentTurnId: data.currentTurnId ? String(data.currentTurnId) : null,
      unresolvedSubmission: unresolvedSubmission,
      lastObservedResponseState: {
        messageId: lastObs.messageId ? String(lastObs.messageId) : null,
        textHash: lastObs.textHash ? String(lastObs.textHash) : null,
        length: Math.max(0, Number(lastObs.length || 0)),
        isStreaming: Boolean(lastObs.isStreaming),
        hasContinueButton: Boolean(lastObs.hasContinueButton),
        stablePolls: Math.max(0, Number(lastObs.stablePolls || 0)),
        observedAt: lastObs.observedAt ? Number(lastObs.observedAt) : null
      },
      lastResponseSummary: sanitizeSecrets(String(data.lastResponseSummary || '')),
      stagedPrompt: sanitizeSecrets(String(data.stagedPrompt || '')),
      turnCount: Math.max(0, Math.floor(Number(data.turnCount || 0))),
      maxTurns: Math.max(1, Math.min(100, Math.floor(Number(data.maxTurns || 8)))),
      maxRuntimeMs: Math.max(60000, Math.floor(Number(data.maxRuntimeMs || 7200000))),
      promptDelayMs: Math.max(1000, Math.floor(Number(data.promptDelayMs || 5000))),
      continuationCount: Math.max(0, Math.floor(Number(data.continuationCount || 0))),
      maxContinuationsPerTurn: Math.max(
        0,
        Math.min(5, Math.floor(Number(data.maxContinuationsPerTurn ?? 2)))
      ),
      retryCount: Math.max(0, Math.floor(Number(data.retryCount || 0))),
      maxRetries: Math.max(1, Math.min(10, Math.floor(Number(data.maxRetries || 3)))),
      backoffBaseMs: Math.max(500, Math.floor(Number(data.backoffBaseMs || 2000))),
      nextRetryAt: data.nextRetryAt ? Number(data.nextRetryAt) : null,
      nextAllowedSubmissionAt: data.nextAllowedSubmissionAt
        ? Number(data.nextAllowedSubmissionAt)
        : null,
      conversationUrl: data.conversationUrl ? String(data.conversationUrl) : null,
      wakeLockEnabled: Boolean(data.wakeLockEnabled),
      localAgentBridgeConfig: {
        mode:
          data.localAgentBridgeConfig && data.localAgentBridgeConfig.mode === 'LOOPBACK_READONLY'
            ? 'LOOPBACK_READONLY'
            : 'NONE',
        endpoint:
          data.localAgentBridgeConfig && typeof data.localAgentBridgeConfig.endpoint === 'string'
            ? data.localAgentBridgeConfig.endpoint
            : ''
      },
      timestamps: {
        createdAt: Number(timestamps.createdAt || now),
        sessionStartedAt: timestamps.sessionStartedAt ? Number(timestamps.sessionStartedAt) : null,
        lastUpdatedAt: Number(timestamps.lastUpdatedAt || now),
        lastSuccessfulActivityAt: timestamps.lastSuccessfulActivityAt
          ? Number(timestamps.lastSuccessfulActivityAt)
          : null,
        lastCheckpointAt: Number(timestamps.lastCheckpointAt || now)
      },
      errors: Array.isArray(data.errors)
        ? data.errors.slice(0, 50).map((err) => ({
            id: String((err && err.id) || generateId('err')),
            timestamp: Number((err && err.timestamp) || now),
            code: String((err && err.code) || 'SESSION_ERROR'),
            message: sanitizeSecrets(String((err && err.message) || String(err))),
            recoverable: Boolean(err && err.recoverable !== false)
          }))
        : [],
      lastError: data.lastError
        ? {
            code: String(data.lastError.code || 'SESSION_ERROR'),
            message: sanitizeSecrets(String(data.lastError.message || data.lastError)),
            timestamp: Number(data.lastError.timestamp || now)
          }
        : null,
      lastSuccessfulCheckpointSummary: sanitizeSecrets(
        String(data.lastSuccessfulCheckpointSummary || 'Checkpoint validated.')
      ),
      activityLog: Array.isArray(data.activityLog)
        ? data.activityLog.slice(0, 100).map((entry) => ({
            id: String((entry && entry.id) || generateId('log')),
            timestamp: Number((entry && entry.timestamp) || now),
            level: ['INFO', 'WARN', 'ERROR', 'SUCCESS'].includes(entry && entry.level)
              ? entry.level
              : 'INFO',
            state: VALID_STATES.includes(entry && entry.state) ? entry.state : normalizedState,
            message: sanitizeSecrets(String((entry && entry.message) || ''))
          }))
        : [
            {
              id: generateId('log'),
              timestamp: now,
              level: 'INFO',
              state: normalizedState,
              message: 'Checkpoint validated.'
            }
          ]
    };

    synchronizeTaskState(validated, syncOptions);

    if (!VALID_STATES.includes(data.state)) {
      validated.lastError = {
        code: 'INVALID_CHECKPOINT_STATE',
        message: `Unrecognized state "${String(data.state)}" repaired to INTERRUPTED for manual review.`,
        timestamp: now
      };
    }

    return validated;
  }

  /**
   * Strictly parses, validates, normalizes, and previews a checkpoint JSON import candidate
   * using the canonical storage rules while enforcing all safety invariants.
   *
   * Returns `{ ok: true, checkpoint, preview, warnings }` or `{ ok: false, code, error }`.
   */
  function prepareCheckpointImport(rawInput, currentStoredCheckpoint) {
    // 1. Parse JSON safely
    let parsed = rawInput;
    if (typeof rawInput === 'string') {
      const trimmed = rawInput.trim();
      if (!trimmed) {
        return {
          ok: false,
          code: 'EMPTY_JSON_INPUT',
          error: 'Checkpoint JSON input is empty. Choose a .json file or paste valid checkpoint JSON.'
        };
      }
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        return {
          ok: false,
          code: 'MALFORMED_JSON',
          error: `Malformed JSON syntax: ${err && err.message ? err.message : String(err)}`
        };
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        code: 'INVALID_ROOT_TYPE',
        error: 'Checkpoint JSON must be a top-level JSON object.'
      };
    }

    // 2. Check existing checkpoint safety lock BEFORE allowing import
    if (
      currentStoredCheckpoint &&
      (currentStoredCheckpoint.unresolvedSubmission !== null ||
        currentStoredCheckpoint.state === 'SUBMITTING')
    ) {
      const lockedTurn =
        (currentStoredCheckpoint.unresolvedSubmission &&
          currentStoredCheckpoint.unresolvedSubmission.turnId) ||
        currentStoredCheckpoint.currentTurnId ||
        'in-flight turn';
      return {
        ok: false,
        code: 'ACTIVE_UNRESOLVED_SUBMISSION_LOCK',
        error: `Import blocked: current session has an unresolved submission lock (${lockedTurn}). Never clear an unresolved submission via JSON import; use the Ambiguity Recovery controls in the Popup first.`
      };
    }

    // 3. Validate schemaVersion strictly
    const hasSchemaVersion = parsed.schemaVersion !== undefined;
    const hasLegacyVersion = parsed.version !== undefined;
    if (!hasSchemaVersion && !hasLegacyVersion) {
      return {
        ok: false,
        code: 'MISSING_SCHEMA_VERSION',
        error: 'Missing required field "schemaVersion" (expected 2, or legacy "version": 1).'
      };
    }

    const rawVer = hasSchemaVersion ? parsed.schemaVersion : parsed.version;
    if (typeof rawVer !== 'number' || !Number.isInteger(rawVer)) {
      return {
        ok: false,
        code: 'INVALID_FIELD_TYPE',
        error: `Invalid field type for "schemaVersion": expected integer, received ${typeof rawVer} (${String(rawVer)}).`
      };
    }

    if (rawVer > CURRENT_SCHEMA_VERSION) {
      return {
        ok: false,
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        error: `Unsupported future schemaVersion "${rawVer}". This version of JARVIS Auto-Pilot supports Schema v${CURRENT_SCHEMA_VERSION} (and legacy v1 migration).`
      };
    }

    if (rawVer < 1 || (rawVer !== CURRENT_SCHEMA_VERSION && !SUPPORTED_LEGACY_VERSIONS.includes(rawVer))) {
      return {
        ok: false,
        code: 'UNSUPPORTED_SCHEMA_VERSION',
        error: `Unsupported schemaVersion "${rawVer}". Supported versions: 1, ${CURRENT_SCHEMA_VERSION}.`
      };
    }

    // 4. Validate required fields & field types before normalization
    const isV1 = rawVer === 1;
    const sessionIdVal = parsed.sessionId;
    if (typeof sessionIdVal !== 'string' || !sessionIdVal.trim()) {
      return {
        ok: false,
        code: 'MISSING_REQUIRED_FIELD',
        error: 'Missing or invalid required string field "sessionId".'
      };
    }

    const objectiveVal = isV1
      ? parsed.projectObjective !== undefined
        ? parsed.projectObjective
        : parsed.objective
      : parsed.projectObjective;
    if (typeof objectiveVal !== 'string' || !objectiveVal.trim()) {
      return {
        ok: false,
        code: 'MISSING_REQUIRED_FIELD',
        error: `Missing or empty required string field "${isV1 ? 'objective / projectObjective' : 'projectObjective'}".`
      };
    }

    if (typeof parsed.state !== 'string' || !VALID_STATES.includes(parsed.state)) {
      return {
        ok: false,
        code: 'INVALID_SESSION_STATE',
        error: `Invalid session state "${String(parsed.state)}". Permitted states: ${VALID_STATES.join(', ')}.`
      };
    }

    const modeField = parsed.operationMode !== undefined ? parsed.operationMode : parsed.mode;
    if (modeField !== undefined && !VALID_MODES.includes(modeField)) {
      return {
        ok: false,
        code: 'INVALID_FIELD_TYPE',
        error: `Invalid operationMode "${String(modeField)}". Permitted modes: SUPERVISED, AUTONOMOUS.`
      };
    }

    if (parsed.pendingTasks !== undefined && !Array.isArray(parsed.pendingTasks)) {
      return {
        ok: false,
        code: 'INVALID_FIELD_TYPE',
        error: 'Invalid field type for "pendingTasks": expected an Array.'
      };
    }

    if (parsed.completedTasks !== undefined && !Array.isArray(parsed.completedTasks)) {
      return {
        ok: false,
        code: 'INVALID_FIELD_TYPE',
        error: 'Invalid field type for "completedTasks": expected an Array.'
      };
    }

    const numericChecks = [
      ['turnCount', parsed.turnCount],
      ['maxTurns', parsed.maxTurns],
      ['maxRuntimeMs', parsed.maxRuntimeMs],
      ['promptDelayMs', parsed.promptDelayMs],
      ['retryCount', parsed.retryCount],
      ['maxRetries', parsed.maxRetries]
    ];
    for (let i = 0; i < numericChecks.length; i++) {
      const [fieldName, val] = numericChecks[i];
      if (val !== undefined && (typeof val !== 'number' || !Number.isFinite(val) || val < 0)) {
        return {
          ok: false,
          code: 'INVALID_FIELD_TYPE',
          error: `Invalid numeric field "${fieldName}": expected a non-negative finite number.`
        };
      }
    }

    if (
      parsed.unresolvedSubmission !== undefined &&
      parsed.unresolvedSubmission !== null &&
      (typeof parsed.unresolvedSubmission !== 'object' || Array.isArray(parsed.unresolvedSubmission))
    ) {
      return {
        ok: false,
        code: 'INVALID_FIELD_TYPE',
        error: 'Invalid field type for "unresolvedSubmission": expected an object or null.'
      };
    }

    // 5. Normalize and migrate via the single canonical validator
    let normalized;
    try {
      const preferQueueHead = Boolean(
        Array.isArray(parsed.pendingTasks) &&
          parsed.pendingTasks.length > 0 &&
          !parsed.currentMilestone &&
          !parsed.milestone
      );
      normalized = validateAndNormalizeCheckpoint(
        JSON.parse(JSON.stringify(parsed)),
        { preferQueueHead }
      );
    } catch (err) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        error: err && err.message ? err.message : String(err)
      };
    }

    const warnings = [];
    const originalState = normalized.state;

    // 6. Enforce Critical Safety Invariants on Imported State:
    // Invariant A: If the imported checkpoint carries an unresolvedSubmission or is in SUBMITTING,
    // force state to INTERRUPTED so the operator must explicitly verify recovery.
    if (normalized.unresolvedSubmission || normalized.state === 'SUBMITTING') {
      if (!normalized.unresolvedSubmission) {
        const fallbackPrompt = normalized.lastSubmittedPrompt || normalized.stagedPrompt || '[Imported Submitting Turn]';
        normalized.unresolvedSubmission = {
          turnId: normalized.currentTurnId || generateId('turn_import'),
          promptText: fallbackPrompt,
          promptHash: computeTextHash(fallbackPrompt),
          submittedAt: Date.now(),
          verifiedInDom: false
        };
      }
      normalized.state = 'INTERRUPTED';
      warnings.push(
        'Imported checkpoint contained an unresolved submission; state clamped to INTERRUPTED for manual verification.'
      );
    }

    // Invariant B: Never allow an imported checkpoint to jump directly into an active submission
    // or autonomous execution loop (`READY`, `GENERATING`, `CONTINUING`, `RESPONSE_COMPLETE`).
    const activeLoopStates = ['READY', 'GENERATING', 'CONTINUING', 'RESPONSE_COMPLETE'];
    if (activeLoopStates.includes(normalized.state)) {
      const safeTarget =
        normalized.operationMode === 'SUPERVISED' ? 'WAITING_FOR_APPROVAL' : 'PAUSED';
      warnings.push(
        `Active state "${normalized.state}" clamped to "${safeTarget}" on import so no prompt is auto-submitted without operator action.`
      );
      normalized.state = safeTarget;
    }

    // Invariant C: Keep Emergency Stop effective if the currently stored session is STOPPED
    if (currentStoredCheckpoint && currentStoredCheckpoint.state === 'STOPPED') {
      if (normalized.state !== 'STOPPED') {
        warnings.push(
          `Emergency Stop is currently active; imported state "${normalized.state}" held in "STOPPED" until you explicitly start a new session.`
        );
        normalized.state = 'STOPPED';
      }
    }

    // Ensure task synchronization invariant holds on the final normalized checkpoint
    synchronizeTaskState(normalized);

    const preview = {
      schemaVersion: normalized.schemaVersion,
      migratedFromVersion: isV1 ? 1 : null,
      state: normalized.state,
      originalState,
      operationMode: normalized.operationMode,
      sessionId: normalized.sessionId,
      currentMilestone: normalized.currentMilestone || '(None)',
      nextProposedAction:
        normalized.nextProposedAction ||
        resolveCanonicalActiveTask(normalized) ||
        '(None)',
      pendingTaskCount: Array.isArray(normalized.pendingTasks)
        ? normalized.pendingTasks.length
        : 0,
      turnCount: normalized.turnCount,
      maxTurns: normalized.maxTurns,
      unresolvedSubmissionStatus: normalized.unresolvedSubmission
        ? `LOCKED (${normalized.unresolvedSubmission.turnId})`
        : 'None (Clean)',
      warnings
    };

    return {
      ok: true,
      checkpoint: normalized,
      preview,
      warnings
    };
  }

  /**
   * Storage Engine Adapter supporting chrome.storage.local with an in-memory/localStorage
   * fallback for unit testing and sandbox inspection.
   */
  class JarvisStorageEngine {
    constructor(chromeStorageOverride) {
      this._customStorage = chromeStorageOverride || null;
      this._memoryStore = {};
      this._importInProgress = false;
    }

    _getBackend() {
      if (this._customStorage) {
        return this._customStorage;
      }
      if (
        typeof chrome !== 'undefined' &&
        chrome &&
        chrome.storage &&
        chrome.storage.local
      ) {
        return chrome.storage.local;
      }
      return null;
    }

    async _rawGet(key) {
      const backend = this._getBackend();
      if (backend) {
        return new Promise((resolve, reject) => {
          try {
            const maybePromise = backend.get([key], (result) => {
              if (
                typeof chrome !== 'undefined' &&
                chrome.runtime &&
                chrome.runtime.lastError
              ) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(result ? result[key] : undefined);
            });
            if (maybePromise && typeof maybePromise.then === 'function' && backend.get.length < 2) {
              maybePromise.then((res) => resolve(res ? res[key] : undefined)).catch(reject);
            }
          } catch (err) {
            reject(err);
          }
        });
      }

      if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(key);
          return raw ? JSON.parse(raw) : undefined;
        } catch (_e) {
          return this._memoryStore[key];
        }
      }
      return this._memoryStore[key];
    }

    async _rawSet(key, value) {
      const backend = this._getBackend();
      const cloned = JSON.parse(JSON.stringify(value));
      if (backend) {
        return new Promise((resolve, reject) => {
          try {
            backend.set({ [key]: cloned }, () => {
              if (
                typeof chrome !== 'undefined' &&
                chrome.runtime &&
                chrome.runtime.lastError
              ) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(cloned);
            });
          } catch (err) {
            reject(err);
          }
        });
      }

      this._memoryStore[key] = cloned;
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(key, JSON.stringify(cloned));
        } catch (_e) {
          // Ignore quota errors in fallback mode
        }
      }
      return cloned;
    }

    async _rawRemove(key) {
      const backend = this._getBackend();
      if (backend && typeof backend.remove === 'function') {
        return new Promise((resolve) => {
          backend.remove([key], () => resolve());
        });
      }
      delete this._memoryStore[key];
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.removeItem(key);
        } catch (_e) {}
      }
    }

    async loadCheckpoint() {
      try {
        const stored = await this._rawGet(STORAGE_KEY_CHECKPOINT);
        if (!stored) {
          const savedSettings = await this._rawGet(STORAGE_KEY_SETTINGS);
          const fresh = createDefaultCheckpoint(savedSettings || undefined);
          await this._rawSet(STORAGE_KEY_CHECKPOINT, fresh);
          return fresh;
        }
        const validated = validateAndNormalizeCheckpoint(stored);
        if (stored.schemaVersion !== CURRENT_SCHEMA_VERSION) {
          await this._rawSet(STORAGE_KEY_CHECKPOINT, validated);
        }
        return validated;
      } catch (err) {
        const fallback = createDefaultCheckpoint({
          state: 'INTERRUPTED',
          lastError: {
            code: 'CHECKPOINT_LOAD_FAILURE',
            message: `Checkpoint validation failed: ${err && err.message ? err.message : String(err)}. Stopped for manual recovery.`,
            timestamp: Date.now()
          }
        });
        return fallback;
      }
    }

    /**
     * Persists a validated checkpoint and synchronizes the active task state.
     */
    async saveCheckpoint(checkpoint, summaryMessage, syncOptions) {
      const now = Date.now();
      const validated = validateAndNormalizeCheckpoint(checkpoint, syncOptions);
      validated.timestamps.lastUpdatedAt = now;
      validated.timestamps.lastCheckpointAt = now;
      if (summaryMessage) {
        validated.lastSuccessfulCheckpointSummary = sanitizeSecrets(String(summaryMessage));
      }
      await this._rawSet(STORAGE_KEY_CHECKPOINT, validated);

      if (
        (syncOptions && syncOptions.saveAsConfiguredBaseline) ||
        validated.state === 'IDLE'
      ) {
        await this._rawSet(STORAGE_KEY_SETTINGS, extractConfigProfile(validated));
      }

      return validated;
    }

    /**
     * Explicit configuration save helper used by Options, Popup, and Workbench.
     * Reconciles `currentMilestone`, `pendingTasks`, and `nextProposedAction` so they never disagree,
     * and persists the baseline profile so `resetCheckpoint()` will not revert to stale defaults.
     */
    async saveConfiguration(configUpdates, summaryMessage) {
      const current = await this.loadCheckpoint();
      const updates = configUpdates || {};

      const previousMilestone = current.currentMilestone;
      const previousQueueHead =
        current.pendingTasks && current.pendingTasks[0]
          ? current.pendingTasks[0].title
          : '';

      let hasNewTasksList = false;
      if (Array.isArray(updates.pendingTasks)) {
        current.pendingTasks = normalizePendingTasksList(updates.pendingTasks);
        hasNewTasksList = true;
      }

      let milestoneExplicitlyChanged = false;
      if (typeof updates.currentMilestone === 'string') {
        const incomingMilestone = sanitizeSecrets(updates.currentMilestone.trim());
        milestoneExplicitlyChanged = incomingMilestone !== previousMilestone;
        current.currentMilestone = incomingMilestone;
      }

      const newQueueHead =
        current.pendingTasks && current.pendingTasks[0]
          ? current.pendingTasks[0].title
          : '';
      const queueHeadChanged = hasNewTasksList && newQueueHead !== previousQueueHead;

      let preferQueueHead =
        (queueHeadChanged && !milestoneExplicitlyChanged) ||
        (!current.currentMilestone && Boolean(newQueueHead));
      let preferMilestone =
        milestoneExplicitlyChanged && Boolean(current.currentMilestone);

      if (updates.lastEditedTaskField === 'queue' && Boolean(newQueueHead)) {
        preferQueueHead = true;
        preferMilestone = false;
      } else if (updates.lastEditedTaskField === 'milestone' && Boolean(current.currentMilestone)) {
        preferMilestone = true;
        preferQueueHead = false;
      }

      if (typeof updates.projectObjective === 'string' && updates.projectObjective.trim()) {
        current.projectObjective = sanitizeSecrets(updates.projectObjective.trim());
      }
      if (typeof updates.projectContext === 'string' && updates.projectContext.trim()) {
        current.projectContext = sanitizeSecrets(updates.projectContext.trim());
      }
      if (VALID_MODES.includes(updates.operationMode)) {
        current.operationMode = updates.operationMode;
      }
      if (typeof updates.maxTurns === 'number') {
        current.maxTurns = Math.max(1, Math.min(100, Math.floor(updates.maxTurns)));
      }
      if (typeof updates.maxRuntimeMs === 'number') {
        current.maxRuntimeMs = Math.max(60000, Math.floor(updates.maxRuntimeMs));
      }
      if (typeof updates.promptDelayMs === 'number') {
        current.promptDelayMs = Math.max(1000, Math.floor(updates.promptDelayMs));
      }
      if (typeof updates.maxRetries === 'number') {
        current.maxRetries = Math.max(1, Math.min(10, Math.floor(updates.maxRetries)));
      }
      if (typeof updates.backoffBaseMs === 'number') {
        current.backoffBaseMs = Math.max(500, Math.floor(updates.backoffBaseMs));
      }
      if (typeof updates.wakeLockEnabled === 'boolean') {
        current.wakeLockEnabled = updates.wakeLockEnabled;
      }

      synchronizeTaskState(current, { preferQueueHead, preferMilestone });

      if (!current.unresolvedSubmission) {
        if (
          (current.state === 'WAITING_FOR_APPROVAL' || current.state === 'READY') &&
          root.JarvisSessionController &&
          typeof root.JarvisSessionController.buildContinuationPrompt === 'function'
        ) {
          const turnId = current.currentTurnId || generateId('turn');
          current.currentTurnId = turnId;
          current.stagedPrompt = root.JarvisSessionController.buildContinuationPrompt(
            current,
            turnId
          );
        } else {
          current.stagedPrompt = '';
        }
      }

      const saved = await this.saveCheckpoint(
        current,
        summaryMessage || 'Configuration saved and task state synchronized.',
        { preferQueueHead, preferMilestone, saveAsConfiguredBaseline: true }
      );

      await this._rawSet(STORAGE_KEY_SETTINGS, extractConfigProfile(saved));
      return saved;
    }

    /**
     * Stage 1 of Checkpoint Import: Validates and generates a preview without mutating stored state.
     */
    async previewCheckpointImport(rawInput) {
      const current = await this.loadCheckpoint();
      return prepareCheckpointImport(rawInput, current);
    }

    /**
     * Stage 2 of Checkpoint Import: Commits a validated checkpoint after operator confirmation.
     * Prevents concurrent/double-click imports and never overwrites an unresolved submission lock.
     */
    async commitCheckpointImport(rawOrPreparedInput) {
      if (this._importInProgress) {
        throw new Error('An import operation is already in progress. Please wait.');
      }
      this._importInProgress = true;
      try {
        const current = await this.loadCheckpoint();
        const candidateRaw =
          rawOrPreparedInput &&
          typeof rawOrPreparedInput === 'object' &&
          rawOrPreparedInput.ok === true &&
          rawOrPreparedInput.checkpoint
            ? rawOrPreparedInput.checkpoint
            : rawOrPreparedInput;

        const prepared = prepareCheckpointImport(candidateRaw, current);
        if (!prepared.ok) {
          throw new Error(prepared.error);
        }

        const toCommit = prepared.checkpoint;
        const now = Date.now();
        toCommit.activityLog.unshift({
          id: generateId('log'),
          timestamp: now,
          level: prepared.warnings.length > 0 ? 'WARN' : 'INFO',
          state: toCommit.state,
          message:
            prepared.warnings.length > 0
              ? `Imported checkpoint (${prepared.warnings.join(' ')})`
              : `Imported and committed checkpoint "${toCommit.sessionId}" (Schema v${toCommit.schemaVersion}).`
        });

        const saved = await this.saveCheckpoint(
          toCommit,
          `Imported checkpoint ${toCommit.sessionId}.`,
          { saveAsConfiguredBaseline: true }
        );
        return {
          ok: true,
          checkpoint: saved,
          preview: prepared.preview,
          warnings: prepared.warnings
        };
      } finally {
        this._importInProgress = false;
      }
    }

    /**
     * Resets session progress (`turnCount`, `completedTasks`, `state`, `errors`, `unresolvedSubmission`).
     * By default, preserves the user's saved configuration (`STORAGE_KEY_SETTINGS`) so resetting
     * a session never silently restores stale factory tasks after a user configured their session.
     * Pass `{ factoryReset: true }` to wipe saved settings and restore factory defaults.
     */
    async resetCheckpoint(overrides) {
      const opts = overrides || {};
      if (opts.factoryReset) {
        await this._rawRemove(STORAGE_KEY_SETTINGS);
        const factory = createDefaultCheckpoint();
        await this._rawSet(STORAGE_KEY_CHECKPOINT, factory);
        return factory;
      }

      const savedProfile = await this._rawGet(STORAGE_KEY_SETTINGS);
      const mergedOverrides = Object.assign({}, savedProfile || {}, opts);
      delete mergedOverrides.factoryReset;

      const fresh = createDefaultCheckpoint(mergedOverrides);
      fresh.activityLog.unshift({
        id: generateId('log'),
        timestamp: Date.now(),
        level: 'INFO',
        state: 'IDLE',
        message: savedProfile
          ? 'Session progress reset (preserved saved user configuration and task queue).'
          : 'Session reset to default configuration.'
      });
      await this._rawSet(STORAGE_KEY_CHECKPOINT, fresh);
      return fresh;
    }
  }

  const exported = {
    CURRENT_SCHEMA_VERSION,
    SUPPORTED_LEGACY_VERSIONS,
    STORAGE_KEY_CHECKPOINT,
    STORAGE_KEY_SETTINGS,
    VALID_STATES,
    VALID_MODES,
    DEFAULT_JARVIS_OBJECTIVE,
    DEFAULT_JARVIS_CONTEXT,
    DEFAULT_INITIAL_MILESTONE,
    DEFAULT_PENDING_TASKS,
    CONTINUATION_POLICY_RULES,
    sanitizeSecrets,
    computeTextHash,
    generateId,
    normalizePendingTasksList,
    synchronizeTaskState,
    resolveCanonicalActiveTask,
    createDefaultCheckpoint,
    migrateCheckpoint,
    validateAndNormalizeCheckpoint,
    prepareCheckpointImport,
    JarvisStorageEngine
  };

  root.JarvisStorage = exported;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
