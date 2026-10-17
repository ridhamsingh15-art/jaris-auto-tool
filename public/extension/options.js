/**
 * JARVIS Auto-Pilot — Options Studio Controller
 * Canonical Manifest V3 Module (options.js)
 *
 * Responsibilities:
 * - Synchronize projectObjective, currentMilestone, pendingTasks, and nextProposedAction
 *   via the canonical storage.saveConfiguration() method.
 * - Never overwrite controlled/editable input values mid-keystroke; track lastEditedTaskField
 *   so saving reconciles currentMilestone, pendingTasks[0], and nextProposedAction deterministically.
 * - Provide a 2-step Checkpoint JSON Import workflow:
 *   1) Choose .json file (via FileReader / file.text()) or paste JSON -> Validate & Preview
 *   2) Explicit operator confirmation -> Commit Checkpoint Import
 * - Preserve existing stored checkpoint and form state unchanged if parsing, validation,
 *   migration, or saving fails.
 */
(function (root) {
  'use strict';

  const StorageMod = root.JarvisStorage;
  if (!StorageMod) return;

  /**
   * Reads a File or Blob object as UTF-8 text using FileReader (or text() fallback).
   */
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error('No file provided.'));
        return;
      }
      if (typeof FileReader !== 'undefined') {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () =>
          reject(new Error(reader.error ? reader.error.message : 'Failed to read file.'));
        reader.readAsText(file);
        return;
      }
      if (typeof file.text === 'function') {
        file.text().then(resolve).catch(reject);
        return;
      }
      reject(new Error('File reading API is not available in this environment.'));
    });
  }

  function bindOptionsToDocument(doc, customStorage) {
    if (!doc) return null;
    const storage = customStorage || new StorageMod.JarvisStorageEngine();

    const el = {
      optObjective: doc.getElementById('optObjective'),
      optContext: doc.getElementById('optContext'),
      optCurrentMilestone: doc.getElementById('optCurrentMilestone'),
      optPendingTasks: doc.getElementById('optPendingTasks'),
      optNextActionReadout: doc.getElementById('optNextActionReadout'),
      optMode: doc.getElementById('optMode'),
      optMaxTurns: doc.getElementById('optMaxTurns'),
      optMaxRuntimeMin: doc.getElementById('optMaxRuntimeMin'),
      optPromptDelaySec: doc.getElementById('optPromptDelaySec'),
      optMaxRetries: doc.getElementById('optMaxRetries'),
      optBackoffBaseMs: doc.getElementById('optBackoffBaseMs'),
      optWakeLock: doc.getElementById('optWakeLock'),
      optCheckpointFileInput: doc.getElementById('optCheckpointFileInput'),
      optSelectedFileName: doc.getElementById('optSelectedFileName'),
      optCheckpointJson: doc.getElementById('optCheckpointJson'),
      optImportErrorBox: doc.getElementById('optImportErrorBox'),
      optImportErrorCode: doc.getElementById('optImportErrorCode'),
      optImportErrorText: doc.getElementById('optImportErrorText'),
      optImportPreviewBox: doc.getElementById('optImportPreviewBox'),
      prevSchemaBadge: doc.getElementById('prevSchemaBadge'),
      prevSessionId: doc.getElementById('prevSessionId'),
      prevState: doc.getElementById('prevState'),
      prevMode: doc.getElementById('prevMode'),
      prevTurns: doc.getElementById('prevTurns'),
      prevPendingCount: doc.getElementById('prevPendingCount'),
      prevUnresolved: doc.getElementById('prevUnresolved'),
      prevMilestone: doc.getElementById('prevMilestone'),
      prevNextAction: doc.getElementById('prevNextAction'),
      prevWarningsBox: doc.getElementById('prevWarningsBox'),
      confirmImportCheckpointBtn: doc.getElementById('confirmImportCheckpointBtn'),
      cancelImportCheckpointBtn: doc.getElementById('cancelImportCheckpointBtn'),
      saveAllOptionsBtn: doc.getElementById('saveAllOptionsBtn'),
      importCheckpointBtn: doc.getElementById('importCheckpointBtn'),
      exportCheckpointBtn: doc.getElementById('exportCheckpointBtn'),
      resetCheckpointBtn: doc.getElementById('resetCheckpointBtn'),
      factoryResetCheckpointBtn: doc.getElementById('factoryResetCheckpointBtn'),
      optionsStatusFeedback: doc.getElementById('optionsStatusFeedback')
    };

    if (!el.optObjective) return null;

    let stagedImportResult = null;
    let isCommittingImport = false;
    let lastEditedTaskField = null; // 'milestone' | 'queue' | null

    function setFeedback(msg, isError) {
      if (!el.optionsStatusFeedback) return;
      el.optionsStatusFeedback.textContent = msg;
      el.optionsStatusFeedback.style.color = isError ? '#f87171' : '#4ade80';
    }

    function clearImportError() {
      if (el.optImportErrorBox) {
        el.optImportErrorBox.classList.add('hidden');
      }
    }

    function showImportError(code, message) {
      stagedImportResult = null;
      if (el.optImportPreviewBox) {
        el.optImportPreviewBox.classList.add('hidden');
      }
      if (el.optImportErrorBox) {
        el.optImportErrorBox.classList.remove('hidden');
        if (el.optImportErrorCode) el.optImportErrorCode.textContent = code || 'IMPORT_ERROR';
        if (el.optImportErrorText) el.optImportErrorText.textContent = message;
      }
      setFeedback('Checkpoint validation failed — existing checkpoint preserved', true);
    }

    function clearImportPreview() {
      stagedImportResult = null;
      if (el.optImportPreviewBox) {
        el.optImportPreviewBox.classList.add('hidden');
      }
    }

    function renderImportPreview(prepared) {
      clearImportError();
      stagedImportResult = prepared;
      if (!el.optImportPreviewBox) return;

      const p = prepared.preview;
      el.optImportPreviewBox.classList.remove('hidden');
      if (el.prevSchemaBadge) {
        el.prevSchemaBadge.textContent = p.migratedFromVersion
          ? `Schema v${p.schemaVersion} (Migrated from v${p.migratedFromVersion})`
          : `Schema v${p.schemaVersion}`;
      }
      if (el.prevSessionId) el.prevSessionId.textContent = p.sessionId;
      if (el.prevState) {
        el.prevState.textContent =
          p.originalState && p.originalState !== p.state
            ? `${p.state} (clamped from ${p.originalState})`
            : p.state;
      }
      if (el.prevMode) el.prevMode.textContent = p.operationMode;
      if (el.prevTurns) el.prevTurns.textContent = `${p.turnCount} / ${p.maxTurns}`;
      if (el.prevPendingCount) el.prevPendingCount.textContent = String(p.pendingTaskCount);
      if (el.prevUnresolved) el.prevUnresolved.textContent = p.unresolvedSubmissionStatus;
      if (el.prevMilestone) el.prevMilestone.textContent = p.currentMilestone;
      if (el.prevNextAction) el.prevNextAction.textContent = p.nextProposedAction;

      if (el.prevWarningsBox) {
        if (p.warnings && p.warnings.length > 0) {
          el.prevWarningsBox.classList.remove('hidden');
          el.prevWarningsBox.textContent = p.warnings.join(' | ');
        } else {
          el.prevWarningsBox.classList.add('hidden');
          el.prevWarningsBox.textContent = '';
        }
      }
    }

    function render(cp) {
      lastEditedTaskField = null;
      el.optObjective.value = cp.projectObjective || '';
      el.optContext.value = cp.projectContext || '';
      el.optCurrentMilestone.value = cp.currentMilestone || '';
      el.optPendingTasks.value = (cp.pendingTasks || [])
        .map((t) => t.title)
        .join('\n');
      if (el.optNextActionReadout) {
        el.optNextActionReadout.textContent =
          cp.nextProposedAction ||
          StorageMod.resolveCanonicalActiveTask(cp) ||
          'No action queued';
      }
      el.optMode.value = cp.operationMode || 'SUPERVISED';
      el.optMaxTurns.value = String(cp.maxTurns || 8);
      el.optMaxRuntimeMin.value = String(Math.round((cp.maxRuntimeMs || 7200000) / 60000));
      el.optPromptDelaySec.value = String(Math.round((cp.promptDelayMs || 5000) / 1000));
      el.optMaxRetries.value = String(cp.maxRetries || 3);
      el.optBackoffBaseMs.value = String(cp.backoffBaseMs || 2000);
      el.optWakeLock.checked = Boolean(cp.wakeLockEnabled);
      el.optCheckpointJson.value = JSON.stringify(cp, null, 2);
    }

    // Update only the read-only Next Planned Action preview while typing without mutating other inputs
    el.optCurrentMilestone.addEventListener('input', () => {
      lastEditedTaskField = 'milestone';
      const m = el.optCurrentMilestone.value.trim();
      if (el.optNextActionReadout && m) {
        el.optNextActionReadout.textContent = m;
      }
    });

    el.optPendingTasks.addEventListener('input', () => {
      lastEditedTaskField = 'queue';
      const lines = el.optPendingTasks.value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (el.optNextActionReadout && lines.length > 0) {
        el.optNextActionReadout.textContent = lines[0];
      }
    });

    async function handleSaveConfiguration() {
      try {
        clearImportError();
        clearImportPreview();
        const taskLines = el.optPendingTasks.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);

        const saved = await storage.saveConfiguration(
          {
            projectObjective: el.optObjective.value.trim(),
            projectContext: el.optContext.value.trim(),
            currentMilestone: el.optCurrentMilestone.value.trim(),
            pendingTasks: taskLines,
            lastEditedTaskField,
            operationMode: el.optMode.value,
            maxTurns: Math.max(1, Number(el.optMaxTurns.value || 8)),
            maxRuntimeMs: Math.max(1, Number(el.optMaxRuntimeMin.value || 120)) * 60000,
            promptDelayMs: Math.max(1, Number(el.optPromptDelaySec.value || 5)) * 1000,
            maxRetries: Math.max(1, Number(el.optMaxRetries.value || 3)),
            backoffBaseMs: Math.max(500, Number(el.optBackoffBaseMs.value || 2000)),
            wakeLockEnabled: Boolean(el.optWakeLock.checked)
          },
          'Configuration saved and synchronized via Options Studio.'
        );
        render(saved);
        setFeedback('Configuration saved & synchronized to chrome.storage.local', false);
        return saved;
      } catch (err) {
        setFeedback(err.message || 'Failed to save configuration', true);
        throw err;
      }
    }

    el.saveAllOptionsBtn.addEventListener('click', () => {
      handleSaveConfiguration();
    });

    async function stageAndValidateJsonText(rawText, sourceLabel) {
      const result = await storage.previewCheckpointImport(rawText);
      if (!result.ok) {
        showImportError(result.code, result.error);
        return result;
      }
      renderImportPreview(result);
      setFeedback(
        `${sourceLabel || 'Checkpoint JSON'} validated — review preview and click Confirm & Commit to apply`,
        false
      );
      return result;
    }

    if (el.optCheckpointFileInput) {
      el.optCheckpointFileInput.addEventListener('change', async (evt) => {
        const files = evt.target && evt.target.files;
        const file = files && files[0];
        if (!file) return;

        if (el.optSelectedFileName) {
          el.optSelectedFileName.textContent = `Selected file: ${file.name} (${file.size} bytes)`;
        }

        try {
          const fileText = await readFileAsText(file);
          el.optCheckpointJson.value = fileText;
          await stageAndValidateJsonText(fileText, `File "${file.name}"`);
        } catch (err) {
          showImportError(
            'FILE_READ_ERROR',
            `Could not read file "${file.name}": ${err && err.message ? err.message : String(err)}`
          );
        }
      });
    }

    el.importCheckpointBtn.addEventListener('click', async () => {
      await stageAndValidateJsonText(el.optCheckpointJson.value, 'Checkpoint JSON');
    });

    if (el.confirmImportCheckpointBtn) {
      el.confirmImportCheckpointBtn.addEventListener('click', async () => {
        if (isCommittingImport || !stagedImportResult || !stagedImportResult.ok) {
          return;
        }
        isCommittingImport = true;
        el.confirmImportCheckpointBtn.disabled = true;
        try {
          const committed = await storage.commitCheckpointImport(stagedImportResult);
          clearImportPreview();
          clearImportError();
          render(committed.checkpoint);
          setFeedback(
            `Committed checkpoint "${committed.checkpoint.sessionId}" (State: ${committed.checkpoint.state})`,
            false
          );
        } catch (err) {
          showImportError(
            'COMMIT_IMPORT_ERROR',
            err && err.message ? err.message : String(err)
          );
        } finally {
          isCommittingImport = false;
          el.confirmImportCheckpointBtn.disabled = false;
        }
      });
    }

    if (el.cancelImportCheckpointBtn) {
      el.cancelImportCheckpointBtn.addEventListener('click', async () => {
        clearImportPreview();
        clearImportError();
        const current = await storage.loadCheckpoint();
        el.optCheckpointJson.value = JSON.stringify(current, null, 2);
        setFeedback('Cancelled staged checkpoint import — existing checkpoint preserved', false);
      });
    }

    el.exportCheckpointBtn.addEventListener('click', async () => {
      const cp = await storage.loadCheckpoint();
      const blob = new Blob([JSON.stringify(cp, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = `jarvis-checkpoint-${cp.sessionId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setFeedback('Checkpoint JSON downloaded', false);
    });

    el.resetCheckpointBtn.addEventListener('click', async () => {
      clearImportPreview();
      clearImportError();
      const fresh = await storage.resetCheckpoint();
      render(fresh);
      setFeedback('Session progress reset (saved task queue & configuration preserved)', false);
    });

    if (el.factoryResetCheckpointBtn) {
      el.factoryResetCheckpointBtn.addEventListener('click', async () => {
        clearImportPreview();
        clearImportError();
        const factory = await storage.resetCheckpoint({ factoryReset: true });
        render(factory);
        setFeedback('Restored factory default Schema v2 configuration', false);
      });
    }

    const initialLoadPromise = storage.loadCheckpoint().then(render);

    return {
      storage,
      ready: initialLoadPromise,
      refresh: async () => {
        const cp = await storage.loadCheckpoint();
        render(cp);
        return cp;
      },
      saveConfiguration: handleSaveConfiguration,
      stageAndValidateJsonText,
      confirmStagedImport: async () => {
        if (!stagedImportResult || !stagedImportResult.ok) {
          throw new Error('No valid staged checkpoint import to commit.');
        }
        const committed = await storage.commitCheckpointImport(stagedImportResult);
        clearImportPreview();
        clearImportError();
        render(committed.checkpoint);
        return committed;
      },
      getStagedImport: () => stagedImportResult
    };
  }

  if (typeof document !== 'undefined' && document.getElementById('optObjective')) {
    bindOptionsToDocument(document);
  }

  root.JarvisOptionsController = {
    bindOptionsToDocument,
    readFileAsText
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.JarvisOptionsController;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
