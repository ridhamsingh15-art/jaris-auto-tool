/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCode,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Square,
  Upload
} from 'lucide-react';

// Declare global bindings exposed by the canonical Vanilla JS extension files in /public/extension/*.js
declare global {
  interface Window {
    JarvisStorage: any;
    JarvisLocalAgentBridge: any;
    JarvisDomAdapter: any;
    JarvisSessionController: any;
    JarvisPopupController: any;
    JarvisOptionsController: any;
    JarvisTestSuite: any;
  }
}

type ActiveTab = 'simulator' | 'options' | 'tests' | 'package';

interface TestResultItem {
  id: string;
  category: string;
  title: string;
  passed: boolean;
  durationMs: number;
  error: string | null;
}

interface TestSuiteSummary {
  total: number;
  passed: number;
  failed: number;
  timestamp: number;
  environment: string;
  results: TestResultItem[];
}

const EXTENSION_FILES_MANIFEST = [
  { path: 'manifest.json', role: 'Manifest V3 root configuration & permissions' },
  { path: 'storage.js', role: 'Canonical Schema v2 checkpoint engine & v1->v2 migrator' },
  { path: 'session-controller.js', role: 'Canonical 12-state machine & single-submission lock' },
  { path: 'dom-adapter.js', role: 'Canonical isolated ChatGPT DOM adapter & 4-signal detector' },
  { path: 'local-agent-bridge.js', role: 'Fail-closed hook for future local Windows 11 agent' },
  { path: 'background.js', role: 'MV3 service worker with chrome.alarms recovery' },
  { path: 'content.js', role: 'ChatGPT content script coordinator & wake lock' },
  { path: 'popup.html', role: 'Standalone extension popup markup' },
  { path: 'popup.css', role: 'Standalone extension popup dark console styles' },
  { path: 'popup.js', role: 'Standalone extension popup controller' },
  { path: 'options.html', role: 'Standalone settings & policy studio markup' },
  { path: 'options.css', role: 'Standalone settings & policy studio styles' },
  { path: 'options.js', role: 'Standalone settings & checkpoint JSON controller' },
  { path: 'tests/extension.test.js', role: 'Automated verification & regression test suite' },
  { path: 'README.md', role: 'Windows 11 installation & supervised smoke test guide' }
];

const EDITABLE_INPUT_CLASS =
  'w-full bg-[#0B0F17] border border-slate-700 hover:border-slate-500 focus:border-sky-400 focus:ring-1 focus:ring-sky-400/30 rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none transition-colors cursor-text pointer-events-auto relative z-10';

const EDITABLE_MONO_INPUT_CLASS =
  'w-full bg-[#0B0F17] border border-slate-700 hover:border-slate-500 focus:border-sky-400 focus:ring-1 focus:ring-sky-400/30 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-100 placeholder-slate-500 focus:outline-none transition-colors cursor-text pointer-events-auto relative z-10';

const EDITABLE_SELECT_CLASS =
  'w-full bg-[#0B0F17] border border-slate-700 hover:border-slate-500 focus:border-sky-400 focus:ring-1 focus:ring-sky-400/30 rounded px-2.5 py-1.5 text-xs font-semibold text-slate-100 focus:outline-none transition-colors cursor-pointer pointer-events-auto relative z-10';

const READONLY_DERIVED_BOX_CLASS =
  'w-full bg-slate-900/55 border border-dashed border-slate-700/80 rounded px-2.5 py-2 text-xs font-mono text-sky-300 select-text cursor-default';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('simulator');
  const [checkpoint, setCheckpoint] = useState<any>(null);
  const [statusBanner, setStatusBanner] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);
  const [lastEditedTaskField, setLastEditedTaskField] = useState<
    'milestone' | 'queue' | 'nextAction' | null
  >(null);
  const [isExportingZip, setIsExportingZip] = useState<boolean>(false);

  // Simulated ChatGPT DOM state wired to the canonical ChatGPTDomAdapter
  const [simDomState, setSimDomState] = useState({
    url: 'https://chatgpt.com/c/jarvis-win11-session',
    hasComposer: true,
    hasSendButton: true,
    isGenerating: false,
    hasContinueButton: false,
    autoEchoUserTurnOnSend: true,
    rateLimitBannerText: '',
    networkErrorBannerText: '',
    authChallengeActive: false,
    stablePolls: 0,
    requiredStablePolls: 3,
    userTurns: [] as { id: string; text: string }[],
    assistantTurns: [] as { id: string; text: string }[]
  });

  // Editable form state synced with checkpoint (numeric fields stored as strings while typing so backspacing/editing never resets to 0)
  const [formObjective, setFormObjective] = useState('');
  const [formContext, setFormContext] = useState('');
  const [formMilestone, setFormMilestone] = useState('');
  const [formPendingTasks, setFormPendingTasks] = useState('');
  const [formNextAction, setFormNextAction] = useState('');
  const [formMode, setFormMode] = useState<'SUPERVISED' | 'AUTONOMOUS'>('SUPERVISED');
  const [formMaxTurns, setFormMaxTurns] = useState('8');
  const [formMaxRuntimeMin, setFormMaxRuntimeMin] = useState('120');
  const [formPromptDelaySec, setFormPromptDelaySec] = useState('5');
  const [formMaxRetries, setFormMaxRetries] = useState('3');
  const [formBackoffBaseMs, setFormBackoffBaseMs] = useState('2000');
  const [formWakeLock, setFormWakeLock] = useState(false);

  // Checkpoint JSON Import & Preview state
  const [rawCheckpointJson, setRawCheckpointJson] = useState('');
  const [isJsonDirty, setIsJsonDirty] = useState(false);
  const [selectedImportFileName, setSelectedImportFileName] = useState('');
  const [stagedImportResult, setStagedImportResult] = useState<any>(null);
  const [importError, setImportError] = useState<{ code: string; message: string } | null>(null);
  const [isCommittingImport, setIsCommittingImport] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Test Suite state
  const [testSummary, setTestSummary] = useState<TestSuiteSummary | null>(null);
  const [isRunningTests, setIsRunningTests] = useState(false);

  // Package Inspector state
  const [selectedFilePath, setSelectedFilePath] = useState('manifest.json');
  const [selectedFileContent, setSelectedFileContent] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);

  // Canonical engine refs
  const storageRef = useRef<any>(null);
  const controllerRef = useRef<any>(null);
  const mockDomRef = useRef<any>(null);
  const domAdapterRef = useRef<any>(null);

  const showNotice = (message: string, isError = false) => {
    setStatusBanner({ message, isError });
  };

  const syncUiFromCheckpoint = (
    cp: any,
    updateFormFields = true,
    updateJsonTextbox = true
  ) => {
    if (window.JarvisStorage?.synchronizeTaskState) {
      window.JarvisStorage.synchronizeTaskState(cp);
    }
    setCheckpoint({ ...cp });
    if (updateJsonTextbox) {
      setRawCheckpointJson(JSON.stringify(cp, null, 2));
      setIsJsonDirty(false);
    }
    if (updateFormFields) {
      setFormObjective(cp.projectObjective || '');
      setFormContext(cp.projectContext || '');
      setFormMilestone(cp.currentMilestone || '');
      setFormPendingTasks((cp.pendingTasks || []).map((t: any) => t.title).join('\n'));
      setFormNextAction(cp.nextProposedAction || cp.currentMilestone || '');
      setFormMode(cp.operationMode || 'SUPERVISED');
      setFormMaxTurns(String(cp.maxTurns || 8));
      setFormMaxRuntimeMin(String(Math.round((cp.maxRuntimeMs || 7200000) / 60000)));
      setFormPromptDelaySec(String(Math.round((cp.promptDelayMs || 5000) / 1000)));
      setFormMaxRetries(String(cp.maxRetries || 3));
      setFormBackoffBaseMs(String(cp.backoffBaseMs || 2000));
      setFormWakeLock(Boolean(cp.wakeLockEnabled));
      setLastEditedTaskField(null);
      setHasUnsavedChanges(false);
    }
    if (domAdapterRef.current && mockDomRef.current) {
      const obs = domAdapterRef.current.observePageState();
      setSimDomState({
        url: mockDomRef.current.state.url,
        hasComposer: mockDomRef.current.state.hasComposer,
        hasSendButton: mockDomRef.current.state.hasSendButton,
        isGenerating: mockDomRef.current.state.isGenerating,
        hasContinueButton: mockDomRef.current.state.hasContinueButton,
        autoEchoUserTurnOnSend: mockDomRef.current.state.autoEchoUserTurnOnSend,
        rateLimitBannerText: mockDomRef.current.state.rateLimitBannerText,
        networkErrorBannerText: mockDomRef.current.state.networkErrorBannerText,
        authChallengeActive: mockDomRef.current.state.authChallengeActive,
        stablePolls: obs.stablePolls,
        requiredStablePolls: obs.requiredStablePolls,
        userTurns: [...mockDomRef.current.state.userTurns],
        assistantTurns: [...mockDomRef.current.state.assistantTurns]
      });
    }
  };

  // Initialize canonical extension modules on mount
  useEffect(() => {
    if (!window.JarvisStorage || !window.JarvisSessionController || !window.JarvisDomAdapter) {
      return;
    }

    const storage = new window.JarvisStorage.JarvisStorageEngine();
    const mockDom = window.JarvisTestSuite.createMockChatGPTDom({
      url: 'https://chatgpt.com/c/jarvis-win11-session',
      autoEchoUserTurnOnSend: true
    });
    const domAdapter = new window.JarvisDomAdapter.ChatGPTDomAdapter({
      document: mockDom.document,
      window: mockDom.window,
      requiredStablePolls: 3
    });
    const controller = new window.JarvisSessionController.SessionController({
      storage,
      domAdapter
    });

    storageRef.current = storage;
    mockDomRef.current = mockDom;
    domAdapterRef.current = domAdapter;
    controllerRef.current = controller;

    storage.loadCheckpoint().then((cp: any) => {
      syncUiFromCheckpoint(cp, true, true);
    });

    // Run automated test suite once on initialization using isolated mock storage
    if (window.JarvisTestSuite) {
      window.JarvisTestSuite.runAllAutomatedTests().then((res: TestSuiteSummary) => {
        setTestSummary(res);
      });
    }
  }, []);

  // Load selected extension source file for inspection
  useEffect(() => {
    let cancelled = false;
    setLoadingFile(true);
    fetch(`/extension/${selectedFilePath}`)
      .then((r) => r.text())
      .then((txt) => {
        if (!cancelled) {
          setSelectedFileContent(txt);
          setLoadingFile(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedFileContent('Unable to load file preview.');
          setLoadingFile(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFilePath]);

  // Controlled field change handlers — NEVER overwrite other fields mid-keystroke
  const handleObjectiveChange = (val: string) => {
    setFormObjective(val);
    setHasUnsavedChanges(true);
  };

  const handleContextChange = (val: string) => {
    setFormContext(val);
    setHasUnsavedChanges(true);
  };

  const handleMilestoneChange = (val: string) => {
    setFormMilestone(val);
    setLastEditedTaskField('milestone');
    setHasUnsavedChanges(true);
  };

  const handlePendingTasksChange = (val: string) => {
    setFormPendingTasks(val);
    setLastEditedTaskField('queue');
    setHasUnsavedChanges(true);
  };

  const handleNextActionChange = (val: string) => {
    setFormNextAction(val);
    setLastEditedTaskField('nextAction');
    setHasUnsavedChanges(true);
  };

  const handleModeChange = (val: 'SUPERVISED' | 'AUTONOMOUS') => {
    setFormMode(val);
    setHasUnsavedChanges(true);
  };

  // Package & Download Standalone Root-Level MV3 Extension ZIP
  const handleDownloadExtensionZip = async () => {
    setIsExportingZip(true);
    try {
      const zip = new JSZip();

      for (const fileMeta of EXTENSION_FILES_MANIFEST) {
        const res = await fetch(`/extension/${fileMeta.path}`);
        if (res.ok) {
          const text = await res.text();
          zip.file(fileMeta.path, text);
        }
      }

      for (const size of [16, 48, 128]) {
        const iconRes = await fetch(`/extension/icons/icon${size}.png`);
        if (iconRes.ok) {
          const buf = await iconRes.arrayBuffer();
          zip.file(`icons/icon${size}.png`, buf);
        }
      }

      const blob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jarvis-autopilot-mv3-extension.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showNotice('Exported jarvis-autopilot-mv3-extension.zip (manifest.json at root)', false);
    } catch (_err) {
      const a = document.createElement('a');
      a.href = '/jarvis-autopilot-mv3-extension.zip';
      a.download = 'jarvis-autopilot-mv3-extension.zip';
      a.click();
      showNotice('Downloaded pre-packaged jarvis-autopilot-mv3-extension.zip', false);
    } finally {
      setIsExportingZip(false);
    }
  };

  const getFormConfigurationUpdates = () => {
    const taskLines = formPendingTasks
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const parsedMaxTurns = Number.parseInt(formMaxTurns, 10);
    const parsedMaxRuntimeMin = Number.parseFloat(formMaxRuntimeMin);
    const parsedPromptDelaySec = Number.parseFloat(formPromptDelaySec);
    const parsedMaxRetries = Number.parseInt(formMaxRetries, 10);
    const parsedBackoffBaseMs = Number.parseInt(formBackoffBaseMs, 10);

    const effectiveMilestone =
      lastEditedTaskField === 'nextAction' && formNextAction.trim()
        ? formNextAction.trim()
        : formMilestone.trim();
    const effectiveLastEditedField =
      lastEditedTaskField === 'nextAction' ? 'milestone' : lastEditedTaskField;

    return {
      projectObjective: formObjective.trim(),
      projectContext: formContext.trim(),
      currentMilestone: effectiveMilestone,
      pendingTasks: taskLines,
      lastEditedTaskField: effectiveLastEditedField,
      operationMode: formMode,
      maxTurns: Math.max(1, Math.min(100, Number.isFinite(parsedMaxTurns) ? parsedMaxTurns : 8)),
      maxRuntimeMs:
        Math.max(1, Number.isFinite(parsedMaxRuntimeMin) ? parsedMaxRuntimeMin : 120) * 60000,
      promptDelayMs:
        Math.max(1, Number.isFinite(parsedPromptDelaySec) ? parsedPromptDelaySec : 5) * 1000,
      maxRetries: Math.max(
        1,
        Math.min(10, Number.isFinite(parsedMaxRetries) ? parsedMaxRetries : 3)
      ),
      backoffBaseMs: Math.max(
        500,
        Number.isFinite(parsedBackoffBaseMs) ? parsedBackoffBaseMs : 2000
      ),
      wakeLockEnabled: Boolean(formWakeLock)
    };
  };

  // Canonical Session Controller Actions
  const handleSaveCheckpointConfig = async () => {
    if (!storageRef.current) return;
    try {
      setImportError(null);
      setStagedImportResult(null);

      const saved = await storageRef.current.saveConfiguration(
        getFormConfigurationUpdates(),
        'Configuration saved and task state synchronized by operator.'
      );
      syncUiFromCheckpoint(saved, true, true);
      showNotice(
        `Configuration saved & synchronized (Active task: "${saved.currentMilestone}")`,
        false
      );
    } catch (err: any) {
      showNotice(err?.message || 'Failed to save configuration.', true);
    }
  };

  const handleReloadSavedConfig = async () => {
    if (!storageRef.current) return;
    try {
      const reloaded = await storageRef.current.loadCheckpoint();
      syncUiFromCheckpoint(reloaded, true, true);
      showNotice('Reloaded persisted checkpoint configuration from storage.', false);
    } catch (err: any) {
      showNotice(err?.message || 'Failed to reload configuration.', true);
    }
  };

  const handleStartSession = async () => {
    if (!controllerRef.current) return;
    try {
      setImportError(null);
      setStagedImportResult(null);

      const cp = await controllerRef.current.startSession(getFormConfigurationUpdates());
      syncUiFromCheckpoint(cp, true, true);
      showNotice(`Session initialized in ${cp.operationMode} mode (${cp.state})`, false);
    } catch (err: any) {
      showNotice(err?.message || 'Failed to start session.', true);
    }
  };

  const handleApproveAndSend = async () => {
    if (!controllerRef.current || !mockDomRef.current || !storageRef.current) return;
    try {
      await storageRef.current.saveConfiguration(
        getFormConfigurationUpdates(),
        'Synchronized configuration prior to turn approval.'
      );
      const cp = await controllerRef.current.approveAndSubmitPrompt();
      if (cp.state === 'GENERATING' && mockDomRef.current.state.isGenerating) {
        mockDomRef.current.state.assistantTurns.push({
          id: `asst_turn_${cp.turnCount}`,
          text: `[Streaming response for Turn ${cp.turnCount}: ${cp.currentMilestone}...]`
        });
      }
      syncUiFromCheckpoint(cp, true, true);
      showNotice(`Turn submitted -> State: ${cp.state}`, false);
    } catch (err: any) {
      showNotice(err?.message || 'Submission blocked', true);
    }
  };

  const handlePauseSession = async () => {
    if (!controllerRef.current) return;
    const cp = await controllerRef.current.pauseSession('Operator clicked Pause.');
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice('Session PAUSED', false);
  };

  const handleResumeSession = async () => {
    if (!controllerRef.current) return;
    const cp = await controllerRef.current.resumeSession();
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice(`Session resumed -> ${cp.state}`, false);
  };

  const handleEmergencyStop = async () => {
    if (!controllerRef.current || !mockDomRef.current) return;
    mockDomRef.current.state.isGenerating = false;
    const cp = await controllerRef.current.emergencyStop(
      'EMERGENCY STOP activated by operator.'
    );
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice('EMERGENCY STOP: All automated submissions locked out', true);
  };

  const handleResolveAmbiguous = async (resolution: 'CONFIRMED_SENT' | 'CONFIRMED_NOT_SENT') => {
    if (!controllerRef.current) return;
    const cp = await controllerRef.current.resolveAmbiguousSubmission(resolution);
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice(`Resolved ambiguity (${resolution}) -> ${cp.state}`, false);
  };

  // ChatGPT DOM Simulator Controls
  const handleSimCompleteStreamingAndStabilize = async () => {
    if (!mockDomRef.current || !controllerRef.current || !storageRef.current) return;
    const cpCurr = await storageRef.current.loadCheckpoint();

    mockDomRef.current.state.isGenerating = false;
    mockDomRef.current.state.hasContinueButton = false;

    const nextIdx = cpCurr.turnCount + 1;
    const structuredReply = [
      `Completed verification for ${cpCurr.currentMilestone}.`,
      `Summary: Verified checkpoint persistence and fail-closed permission boundaries for Turn ${cpCurr.turnCount}.`,
      `Files Changed: None (ChatGPT web engineering specification)`,
      `Tests Performed: Verified state invariant unit tests locally`,
      `Unresolved Risks: Ensure Windows 11 file locking is handled on concurrent connections`,
      `Next Proposed Milestone: M${nextIdx}: Implement capability registry signature verification and replay protection.`
    ].join('\n');

    if (mockDomRef.current.state.assistantTurns.length === 0) {
      mockDomRef.current.state.assistantTurns.push({
        id: `asst_${Date.now()}`,
        text: structuredReply
      });
    } else {
      mockDomRef.current.state.assistantTurns[
        mockDomRef.current.state.assistantTurns.length - 1
      ].text = structuredReply;
    }

    await controllerRef.current.step();
    await controllerRef.current.step();
    const finalCp = await controllerRef.current.step();
    syncUiFromCheckpoint(finalCp, true, true);
    showNotice(`Verified 3 stable DOM polls -> Transitioned to ${finalCp.state}`, false);
  };

  const handleSimSingleObservationTick = async () => {
    if (!controllerRef.current) return;
    const cp = await controllerRef.current.step();
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice(`Executed controller.step() tick -> State: ${cp.state}`, false);
  };

  const handleSimInjectContinueButton = async () => {
    if (!mockDomRef.current || !controllerRef.current) return;
    mockDomRef.current.state.isGenerating = false;
    mockDomRef.current.state.hasContinueButton = true;
    const cp = await controllerRef.current.step();
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice(`Simulated Continue generating control -> State: ${cp.state}`, false);
  };

  const handleSimInjectRateLimit = async () => {
    if (!mockDomRef.current || !controllerRef.current) return;
    mockDomRef.current.state.rateLimitBannerText =
      "You've reached the current usage cap for GPT-4. Please try again after 02:00 AM.";
    const cp = await controllerRef.current.step();
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice('Simulated ChatGPT usage cap banner -> Halted in INTERRUPTED', true);
  };

  const handleSimInjectAmbiguousRestart = async () => {
    if (!storageRef.current || !controllerRef.current || !mockDomRef.current) return;
    const cp = await storageRef.current.loadCheckpoint();
    const ambigTurnId = `turn_restart_${Date.now().toString().slice(-4)}`;
    cp.state = 'SUBMITTING';
    cp.currentTurnId = ambigTurnId;
    cp.unresolvedSubmission = {
      turnId: ambigTurnId,
      promptText: `[Simulated Unverified Prompt for ${ambigTurnId}]`,
      promptHash: window.JarvisStorage.computeTextHash(
        `[Simulated Unverified Prompt for ${ambigTurnId}]`
      ),
      submittedAt: Date.now(),
      verifiedInDom: false
    };
    await storageRef.current.saveCheckpoint(cp);
    const recovered = await controllerRef.current.recoverFromRestart();
    syncUiFromCheckpoint(recovered, false, !isJsonDirty);
    showNotice('Simulated service-worker restart during SUBMITTING -> INTERRUPTED', true);
  };

  const handleSimClearFaults = async () => {
    if (!mockDomRef.current || !storageRef.current) return;
    mockDomRef.current.state.rateLimitBannerText = '';
    mockDomRef.current.state.networkErrorBannerText = '';
    mockDomRef.current.state.authChallengeActive = false;
    mockDomRef.current.state.hasComposer = true;
    mockDomRef.current.state.autoEchoUserTurnOnSend = true;
    const cp = await storageRef.current.loadCheckpoint();
    cp.conversationUrl = mockDomRef.current.state.url;
    await storageRef.current.saveCheckpoint(cp);
    syncUiFromCheckpoint(cp, false, !isJsonDirty);
    showNotice('Cleared simulated DOM faults', false);
  };

  const handleResetSession = async (factoryReset = false) => {
    if (!storageRef.current || !mockDomRef.current) return;
    setImportError(null);
    setStagedImportResult(null);
    mockDomRef.current.state.userTurns = [];
    mockDomRef.current.state.assistantTurns = [];
    mockDomRef.current.state.isGenerating = false;
    mockDomRef.current.state.hasContinueButton = false;
    mockDomRef.current.state.rateLimitBannerText = '';
    mockDomRef.current.state.networkErrorBannerText = '';
    mockDomRef.current.state.authChallengeActive = false;
    const fresh = await storageRef.current.resetCheckpoint(
      factoryReset ? { factoryReset: true } : undefined
    );
    syncUiFromCheckpoint(fresh, true, true);
    showNotice(
      factoryReset
        ? 'Restored factory default Schema v2 configuration'
        : 'Reset session progress (preserved saved configuration & task queue)',
      false
    );
  };

  const handleRunTestSuite = async () => {
    if (!window.JarvisTestSuite) return;
    setIsRunningTests(true);
    try {
      const res = await window.JarvisTestSuite.runAllAutomatedTests();
      setTestSummary(res);
      showNotice(
        `Executed ${res.total} automated test suites: ${res.passed}/${res.total} PASSED`,
        res.failed > 0
      );
    } finally {
      setIsRunningTests(false);
    }
  };

  // Two-Step Checkpoint JSON Import Workflow (Preview -> Explicit Confirm)
  const stageAndPreviewCheckpointText = async (jsonText: string, sourceLabel: string) => {
    if (!storageRef.current) return;
    const result = await storageRef.current.previewCheckpointImport(jsonText);
    if (!result.ok) {
      setStagedImportResult(null);
      setImportError({
        code: result.code || 'VALIDATION_ERROR',
        message: result.error || 'Checkpoint validation failed.'
      });
      showNotice(
        `Checkpoint import rejected (${result.code}): existing checkpoint preserved`,
        true
      );
      return;
    }
    setImportError(null);
    setStagedImportResult(result);
    showNotice(
      `${sourceLabel} validated — review preview and click Confirm & Commit to apply`,
      false
    );
  };

  const handleFilePickerChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedImportFileName(`${file.name} (${file.size} bytes)`);
    try {
      const readFn = window.JarvisOptionsController?.readFileAsText;
      const text = readFn ? await readFn(file) : await file.text();
      setRawCheckpointJson(text);
      setIsJsonDirty(true);
      await stageAndPreviewCheckpointText(text, `File "${file.name}"`);
    } catch (err: any) {
      setStagedImportResult(null);
      setImportError({
        code: 'FILE_READ_ERROR',
        message: `Failed to read file "${file.name}": ${err?.message || String(err)}`
      });
      showNotice(`Failed to read file "${file.name}"`, true);
    }
  };

  const handleStageManualJsonImport = async () => {
    await stageAndPreviewCheckpointText(rawCheckpointJson, 'Checkpoint JSON');
  };

  const handleStageSampleV1Migration = async () => {
    const sampleV1 = {
      version: 1,
      sessionId: 'jarvis_v1_legacy_session',
      state: 'PAUSED',
      mode: 'SUPERVISED',
      objective: 'Migrate v1 JARVIS checkpoint store to Schema v2',
      pendingTasks: [
        'M1: Validate v1 checkpoint migration without losing in-flight lock',
        'M2: Run pytest verification suite on Windows 11'
      ],
      completedTasks: ['M0: Initial repository bootstrap'],
      turns: 2
    };
    const text = JSON.stringify(sampleV1, null, 2);
    setRawCheckpointJson(text);
    setIsJsonDirty(true);
    setSelectedImportFileName('sample-legacy-v1-checkpoint.json (staged)');
    await stageAndPreviewCheckpointText(text, 'Sample Legacy Schema v1 JSON');
  };

  const handleConfirmCheckpointImport = async () => {
    if (!storageRef.current || !stagedImportResult || !stagedImportResult.ok || isCommittingImport) {
      return;
    }
    setIsCommittingImport(true);
    try {
      const committed = await storageRef.current.commitCheckpointImport(stagedImportResult);
      setStagedImportResult(null);
      setImportError(null);
      syncUiFromCheckpoint(committed.checkpoint, true, true);
      showNotice(
        `Committed imported checkpoint "${committed.checkpoint.sessionId}" (State: ${committed.checkpoint.state})`,
        false
      );
    } catch (err: any) {
      setImportError({
        code: 'COMMIT_IMPORT_ERROR',
        message: err?.message || 'Failed to commit checkpoint import.'
      });
      showNotice(err?.message || 'Failed to commit checkpoint import.', true);
    } finally {
      setIsCommittingImport(false);
    }
  };

  const handleCancelCheckpointImport = async () => {
    setStagedImportResult(null);
    setImportError(null);
    setSelectedImportFileName('');
    setIsJsonDirty(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (storageRef.current) {
      const current = await storageRef.current.loadCheckpoint();
      setRawCheckpointJson(JSON.stringify(current, null, 2));
    }
    showNotice('Cancelled staged checkpoint import — existing checkpoint preserved', false);
  };

  const handleDownloadCheckpointJson = async () => {
    if (!storageRef.current) return;
    const cp = await storageRef.current.loadCheckpoint();
    const blob = new Blob([JSON.stringify(cp, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jarvis-checkpoint-${cp.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showNotice(`Downloaded jarvis-checkpoint-${cp.sessionId}.json`, false);
  };

  const getStateColorClasses = (state: string) => {
    if (['READY', 'GENERATING', 'RESPONSE_COMPLETE', 'COMPLETED'].includes(state)) {
      return 'text-emerald-400';
    }
    if (['WAITING_FOR_APPROVAL', 'PAUSED', 'SUBMITTING', 'CONTINUING'].includes(state)) {
      return 'text-amber-400';
    }
    if (['INTERRUPTED', 'ERROR', 'STOPPED'].includes(state)) {
      return 'text-red-400';
    }
    return 'text-slate-300';
  };

  const formatTimestamp = (ts: number | null | undefined) => {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  if (!checkpoint) {
    return (
      <div className="min-h-screen bg-[#0B0F17] text-slate-200 flex items-center justify-center p-8">
        <div className="text-sm font-mono text-slate-400">
          Loading canonical Manifest V3 modules (/extension/storage.js, /extension/session-controller.js, /extension/dom-adapter.js)...
        </div>
      </div>
    );
  }

  // Compute canonical Next Planned Action readout without mutating input fields mid-typing
  const firstPendingLine = formPendingTasks
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0];

  const canonicalNextAction =
    checkpoint.state === 'COMPLETED'
      ? 'None — session objective complete.'
      : lastEditedTaskField === 'nextAction' && formNextAction.trim()
      ? formNextAction.trim()
      : lastEditedTaskField === 'queue' && firstPendingLine
      ? firstPendingLine
      : lastEditedTaskField === 'milestone' && formMilestone.trim()
      ? formMilestone.trim()
      : formMilestone.trim() ||
        firstPendingLine ||
        window.JarvisStorage?.resolveCanonicalActiveTask?.(checkpoint) ||
        checkpoint.nextProposedAction ||
        checkpoint.currentMilestone ||
        'No action queued';

  const nextActionInputValue =
    lastEditedTaskField === 'nextAction'
      ? formNextAction
      : lastEditedTaskField === 'milestone'
      ? formMilestone
      : lastEditedTaskField === 'queue'
      ? firstPendingLine || ''
      : formNextAction || canonicalNextAction;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-[#0B0F17] sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('simulator');
          }}
          className="text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0 font-display"
        >
          JARVIS Auto-Pilot
        </a>

        {/* Zone 2: 4 single-line navigation links */}
        <nav className="flex items-center gap-6 text-sm font-medium text-slate-400 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('simulator')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer ${
              activeTab === 'simulator'
                ? 'text-slate-50 border-sky-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Live Simulator &amp; Popup
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('options')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer ${
              activeTab === 'options'
                ? 'text-slate-50 border-sky-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Options &amp; Policy Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('tests')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer ${
              activeTab === 'tests'
                ? 'text-slate-50 border-sky-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Automated Test Suite (
            {testSummary ? `${testSummary.passed}/${testSummary.total}` : '19/19'})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('package')}
            className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer ${
              activeTab === 'package'
                ? 'text-slate-50 border-sky-500'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Extension Package &amp; Install
          </button>
        </nav>

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handleDownloadExtensionZip}
            disabled={isExportingZip}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-md hover:bg-sky-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExportingZip ? 'Packaging ZIP...' : 'Download MV3 Extension (.zip)'}</span>
          </button>
        </div>
      </header>

      {/* Sub-header context & live feedback bar */}
      <div className="px-6 py-2.5 border-b border-slate-800/80 bg-[#111827]/60 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-2">
          <span>Manifest V3 Chrome Extension</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">Canonical Vanilla JS Runtime</span>
          <span aria-hidden="true">·</span>
          <span>Target: https://chatgpt.com/*</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums">
            Schema v{checkpoint.schemaVersion}
          </span>
          {hasUnsavedChanges && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-400 font-semibold">
                Unsaved Form Edits (Click Save Configuration to persist)
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-4">
          {statusBanner && (
            <span
              role="status"
              aria-live="polite"
              data-testid="workbench-status-banner"
              className={`font-semibold ${
                statusBanner.isError ? 'text-red-400' : 'text-emerald-400'
              }`}
            >
              {statusBanner.message}
            </span>
          )}
          <span className="font-mono tabular-nums text-slate-400">
            Session: {checkpoint.sessionId}
          </span>
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-6">
        {/* TAB 1: LIVE SIMULATOR & POPUP CONSOLE */}
        {activeTab === 'simulator' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column (5 cols): Canonical Extension Popup Console */}
            <section className="lg:col-span-5 bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div>
                  <h2 className="text-base font-bold text-slate-50 font-display">
                    JARVIS Auto-Pilot — Extension Popup
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Editable session &amp; checkpoint controls bound to <code className="text-slate-300">storage.js</code> &amp; <code className="text-slate-300">session-controller.js</code>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="popup-save-config-btn"
                    onClick={handleSaveCheckpointConfig}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Configuration</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('options')}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-800 rounded border border-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Full Studio
                  </button>
                </div>
              </div>

              {/* Session Status & Emergency Stop (Read-Only Derived Status Box) */}
              <div className="p-3.5 bg-slate-900/55 border border-dashed border-slate-700/80 rounded-md flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-slate-400">
                        Session State
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">
                        READ-ONLY · DERIVED
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span
                        data-testid="workbench-session-state"
                        className={`font-mono text-sm font-semibold ${getStateColorClasses(
                          checkpoint.state
                        )}`}
                      >
                        {checkpoint.state}
                      </span>
                      <span className="text-slate-600">·</span>
                      <span className="text-xs text-slate-300">
                        {checkpoint.operationMode === 'SUPERVISED'
                          ? 'Supervised Mode'
                          : 'Bounded Autonomous'}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleEmergencyStop}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Emergency Stop</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 pt-2 border-t border-slate-800/80 font-mono tabular-nums">
                  <span>
                    Turns: {checkpoint.turnCount} / {checkpoint.maxTurns}
                  </span>
                  <span>·</span>
                  <span>
                    Checkpoint:{' '}
                    {checkpoint.unresolvedSubmission
                      ? 'LOCKED (1 Unresolved)'
                      : 'Synchronized v2'}
                  </span>
                  <span>·</span>
                  <span>
                    Last activity:{' '}
                    {formatTimestamp(checkpoint.timestamps?.lastSuccessfulActivityAt)}
                  </span>
                </div>
              </div>

              {/* Error or Interruption Box */}
              {(checkpoint.lastError ||
                checkpoint.state === 'INTERRUPTED' ||
                checkpoint.state === 'ERROR') && (
                <div
                  role="alert"
                  className="p-3.5 bg-red-950/30 border border-red-800/60 rounded-md flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-semibold text-red-300">
                      {checkpoint.lastError?.code || checkpoint.state}
                    </span>
                    <span className="text-[11px] font-mono text-red-400 tabular-nums">
                      Retries: {checkpoint.retryCount}/{checkpoint.maxRetries}
                    </span>
                  </div>
                  <p className="text-xs text-red-200 leading-relaxed">
                    {checkpoint.lastError?.message ||
                      'Session interrupted. Confirm state before resuming.'}
                  </p>

                  {checkpoint.unresolvedSubmission && (
                    <div className="pt-2 border-t border-red-900/50 flex flex-col gap-2">
                      <span className="text-[11px] text-amber-300 font-medium">
                        Manual Ambiguity Recovery Required (Turn: {checkpoint.unresolvedSubmission.turnId}):
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleResolveAmbiguous('CONFIRMED_SENT')}
                          className="px-2.5 py-1.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white rounded cursor-pointer whitespace-nowrap"
                        >
                          Confirm Message Appeared in ChatGPT
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResolveAmbiguous('CONFIRMED_NOT_SENT')}
                          className="px-2.5 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded cursor-pointer whitespace-nowrap"
                        >
                          Did Not Appear (Re-stage Prompt)
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Primary Execution Controls */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="popup-start-session-btn"
                  onClick={handleStartSession}
                  disabled={Boolean(checkpoint.unresolvedSubmission)}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Start Session</span>
                </button>

                {checkpoint.state === 'WAITING_FOR_APPROVAL' && (
                  <button
                    type="button"
                    data-testid="popup-approve-send-btn"
                    onClick={handleApproveAndSend}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Approve &amp; Send Turn</span>
                  </button>
                )}

                {['PAUSED', 'INTERRUPTED', 'ERROR'].includes(checkpoint.state) ? (
                  <button
                    type="button"
                    onClick={handleResumeSession}
                    className="px-3 py-2 text-xs font-semibold text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded transition-colors whitespace-nowrap cursor-pointer"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handlePauseSession}
                    disabled={['IDLE', 'STOPPED', 'COMPLETED'].includes(checkpoint.state)}
                    className="flex items-center gap-1 px-3 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 rounded transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    <span>Pause</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleResetSession(false)}
                  title="Reset session progress (preserves saved configuration and task queue)"
                  className="px-2.5 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#0B0F17] border border-slate-700 rounded cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Editable Operation Mode & Session Limits */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-mode"
                    className="text-[11px] text-slate-300 font-semibold"
                  >
                    Operation Mode
                  </label>
                  <select
                    id="wb-popup-mode"
                    data-testid="input-operation-mode"
                    value={formMode}
                    onChange={(e) =>
                      handleModeChange(e.target.value as 'SUPERVISED' | 'AUTONOMOUS')
                    }
                    className={EDITABLE_SELECT_CLASS}
                  >
                    <option value="SUPERVISED" className="bg-slate-900">
                      Supervised (Approve Each Turn)
                    </option>
                    <option value="AUTONOMOUS" className="bg-slate-900">
                      Bounded Autonomous
                    </option>
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-max-turns"
                    className="text-[11px] text-slate-300 font-semibold"
                  >
                    Max Turns
                  </label>
                  <input
                    id="wb-popup-max-turns"
                    data-testid="input-max-turns"
                    type="number"
                    min={1}
                    max={100}
                    value={formMaxTurns}
                    onChange={(e) => {
                      setFormMaxTurns(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-max-runtime"
                    className="text-[11px] text-slate-300 font-semibold"
                  >
                    Runtime (m)
                  </label>
                  <input
                    id="wb-popup-max-runtime"
                    data-testid="input-max-runtime"
                    type="number"
                    min={1}
                    max={1440}
                    value={formMaxRuntimeMin}
                    onChange={(e) => {
                      setFormMaxRuntimeMin(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-prompt-delay"
                    className="text-[11px] text-slate-300 font-semibold"
                  >
                    Delay (s)
                  </label>
                  <input
                    id="wb-popup-prompt-delay"
                    data-testid="input-prompt-delay"
                    type="number"
                    min={1}
                    max={600}
                    value={formPromptDelaySec}
                    onChange={(e) => {
                      setFormPromptDelaySec(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-max-retries"
                    className="text-[11px] text-slate-300 font-semibold"
                  >
                    Max Retries
                  </label>
                  <input
                    id="wb-popup-max-retries"
                    data-testid="input-max-retries"
                    type="number"
                    min={1}
                    max={10}
                    value={formMaxRetries}
                    onChange={(e) => {
                      setFormMaxRetries(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-backoff-base"
                    className="text-[11px] text-slate-300 font-semibold"
                  >
                    Backoff (ms)
                  </label>
                  <input
                    id="wb-popup-backoff-base"
                    data-testid="input-backoff-base"
                    type="number"
                    min={500}
                    max={30000}
                    value={formBackoffBaseMs}
                    onChange={(e) => {
                      setFormBackoffBaseMs(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>
              </div>

              {/* Objective, Active Milestone, Pending Milestones Queue, Next Action, and Pinned Context */}
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-objective"
                    className="text-[11px] font-semibold text-slate-300"
                  >
                    Project Objective
                  </label>
                  <textarea
                    id="wb-popup-objective"
                    data-testid="input-project-objective"
                    rows={2}
                    value={formObjective}
                    onChange={(e) => handleObjectiveChange(e.target.value)}
                    className={EDITABLE_INPUT_CLASS}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-milestone"
                    className="text-[11px] font-semibold text-slate-300"
                  >
                    Active Milestone
                  </label>
                  <input
                    id="wb-popup-milestone"
                    data-testid="input-active-milestone"
                    type="text"
                    value={formMilestone}
                    onChange={(e) => handleMilestoneChange(e.target.value)}
                    className={EDITABLE_INPUT_CLASS}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-pending-tasks"
                    className="text-[11px] font-semibold text-slate-300"
                  >
                    Pending Milestones Queue (One per line)
                  </label>
                  <textarea
                    id="wb-popup-pending-tasks"
                    data-testid="input-pending-milestones"
                    rows={3}
                    value={formPendingTasks}
                    onChange={(e) => handlePendingTasksChange(e.target.value)}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>

                {/* Editable Next Planned Action Input Synchronized with Canonical Active Task */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="wb-popup-next-action"
                      className="text-[11px] font-semibold text-slate-300"
                    >
                      Next Planned Action
                    </label>
                    <span className="text-[10px] font-mono text-sky-400">
                      EDITABLE · SYNCED WITH ACTIVE TASK
                    </span>
                  </div>
                  <div data-testid="readout-next-planned-action" className="w-full">
                    <input
                      id="wb-popup-next-action"
                      data-testid="input-next-planned-action"
                      type="text"
                      value={nextActionInputValue}
                      onChange={(e) => handleNextActionChange(e.target.value)}
                      placeholder="Enter or edit next planned action..."
                      className={EDITABLE_MONO_INPUT_CLASS}
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-popup-context"
                    className="text-[11px] font-semibold text-slate-300"
                  >
                    Pinned Project JARVIS Context
                  </label>
                  <textarea
                    id="wb-popup-context"
                    data-testid="input-project-context"
                    rows={4}
                    value={formContext}
                    onChange={(e) => handleContextChange(e.target.value)}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleSaveCheckpointConfig}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Configuration</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleReloadSavedConfig}
                    className="px-3 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded cursor-pointer"
                  >
                    Reload Saved
                  </button>
                </div>
              </div>
            </section>

            {/* Right Column (7 cols): Interactive ChatGPT DOM Sandbox & Activity Audit Log */}
            <div className="lg:col-span-7 flex flex-col gap-6">
              {/* Simulated ChatGPT Page Fixture */}
              <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-4 pb-3 border-b border-slate-800">
                  <div>
                    <h2 className="text-base font-bold text-slate-50 font-display">
                      ChatGPT DOM Adapter Sandbox (<code className="text-xs font-mono text-sky-400">dom-adapter.js</code>)
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Test multi-signal response completion, submission verification, rate-limit banners, and crash recovery
                    </p>
                  </div>
                  <div className="text-xs font-mono text-slate-400 tabular-nums">
                    Stable Polls: {simDomState.stablePolls}/{simDomState.requiredStablePolls} ·{' '}
                    {simDomState.isGenerating ? 'Streaming Active' : 'Idle'}
                  </div>
                </div>

                {/* Simulation Fault & Signal Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSimCompleteStreamingAndStabilize}
                    className="px-3 py-1.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-600 text-white rounded cursor-pointer whitespace-nowrap"
                  >
                    Simulate Assistant Response &amp; 3 Stable Polls
                  </button>
                  <button
                    type="button"
                    onClick={handleSimSingleObservationTick}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded cursor-pointer whitespace-nowrap"
                  >
                    Run Single Observation Tick
                  </button>
                  <button
                    type="button"
                    onClick={handleSimInjectContinueButton}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded cursor-pointer whitespace-nowrap"
                  >
                    Trigger &ldquo;Continue generating&rdquo;
                  </button>
                  <button
                    type="button"
                    onClick={handleSimInjectRateLimit}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 rounded cursor-pointer whitespace-nowrap"
                  >
                    Inject Rate-Limit Cap
                  </button>
                  <button
                    type="button"
                    onClick={handleSimInjectAmbiguousRestart}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-red-300 border border-slate-700 rounded cursor-pointer whitespace-nowrap"
                  >
                    Simulate Restart During Submit
                  </button>
                  <button
                    type="button"
                    onClick={handleSimClearFaults}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-slate-200 cursor-pointer whitespace-nowrap"
                  >
                    Clear Faults
                  </button>
                </div>

                {/* Simulated Conversation Thread */}
                <div className="bg-[#0B0F17] border border-slate-800 rounded-md p-4 min-h-[220px] max-h-[300px] overflow-y-auto flex flex-col gap-3">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 pb-2 border-b border-slate-800/80">
                    <span>DOM Fixture URL: {simDomState.url}</span>
                    <span>
                      Turns in DOM: {simDomState.userTurns.length} User /{' '}
                      {simDomState.assistantTurns.length} Assistant
                    </span>
                  </div>

                  {simDomState.rateLimitBannerText && (
                    <div className="p-2.5 bg-red-950/50 border border-red-800 rounded text-xs text-red-200 font-mono">
                      [DOM role=&quot;alert&quot;] {simDomState.rateLimitBannerText}
                    </div>
                  )}

                  {simDomState.userTurns.length === 0 &&
                    simDomState.assistantTurns.length === 0 && (
                      <div className="my-auto text-center py-8 text-xs text-slate-500">
                        No messages in simulated ChatGPT conversation yet. Click{' '}
                        <strong className="text-slate-300">Start Session</strong> then{' '}
                        <strong className="text-slate-300">Approve &amp; Send Turn</strong> to verify DOM submission.
                      </div>
                    )}

                  {simDomState.userTurns.map((u, idx) => (
                    <div key={u.id} className="flex flex-col gap-2">
                      <div className="p-3 bg-slate-900 border border-slate-800 rounded text-xs">
                        <div className="font-mono text-[11px] text-sky-400 mb-1">
                          [data-message-author-role=&quot;user&quot;] #{idx + 1} ({u.id})
                        </div>
                        <pre className="whitespace-pre-wrap font-mono text-[11px] text-slate-300 max-h-28 overflow-y-auto">
                          {u.text}
                        </pre>
                      </div>

                      {simDomState.assistantTurns[idx] && (
                        <div className="p-3 bg-[#111827] border border-slate-800 rounded text-xs">
                          <div className="flex items-center justify-between font-mono text-[11px] text-emerald-400 mb-1">
                            <span>
                              [data-message-author-role=&quot;assistant&quot;] #{idx + 1}
                            </span>
                            <span>
                              {simDomState.isGenerating &&
                              idx === simDomState.assistantTurns.length - 1
                                ? '[button data-testid="stop-button" VISIBLE]'
                                : '[Generation Complete]'}
                            </span>
                          </div>
                          <pre className="whitespace-pre-wrap font-mono text-[11px] text-slate-200">
                            {simDomState.assistantTurns[idx].text}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Staged Continuation Prompt Preview (Read-Only Derived) */}
                {checkpoint.stagedPrompt && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-300">
                        Staged Continuation Prompt (Turn ID: <code className="font-mono text-sky-400">{checkpoint.currentTurnId}</code>)
                      </span>
                      <span className="font-mono text-[10px] text-slate-500">
                        READ-ONLY · HASH: {window.JarvisStorage.computeTextHash(checkpoint.stagedPrompt)}
                      </span>
                    </div>
                    <pre
                      data-testid="readout-staged-prompt"
                      className="p-3 bg-slate-900/55 border border-dashed border-slate-700/80 rounded text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-36 overflow-y-auto select-text"
                    >
                      {checkpoint.stagedPrompt}
                    </pre>
                  </div>
                )}
              </section>

              {/* State Machine & Checkpoint Activity Log */}
              <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <h3 className="text-sm font-bold text-slate-100 font-display">
                    Persistent Checkpoint Activity &amp; Transition Log
                  </h3>
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    {checkpoint.activityLog?.length || 0} recorded events
                  </span>
                </div>

                <div className="divide-y divide-slate-800/70 max-h-56 overflow-y-auto">
                  {(checkpoint.activityLog || []).slice(0, 20).map((entry: any) => (
                    <div
                      key={entry.id}
                      className="py-2 flex items-baseline justify-between gap-4 text-xs"
                    >
                      <div className="flex items-baseline gap-2.5 min-w-0">
                        <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                          {formatTimestamp(entry.timestamp)}
                        </span>
                        <span
                          className={`font-mono text-[11px] font-semibold shrink-0 ${getStateColorClasses(
                            entry.state
                          )}`}
                        >
                          [{entry.state}]
                        </span>
                        <span className="text-slate-200 truncate" title={entry.message}>
                          {entry.message}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-slate-500 shrink-0">
                        {entry.level}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}

        {/* TAB 2: OPTIONS & POLICY STUDIO */}
        {activeTab === 'options' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-5">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div>
                  <h2 className="text-lg font-bold text-slate-50 font-display">
                    01. Project JARVIS Instructions &amp; Milestone Queue (<code className="text-xs font-mono text-sky-400">options.html</code>)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Edit project objective, active milestone, pending queue, and pinned context
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="options-save-config-btn"
                    onClick={handleSaveCheckpointConfig}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded cursor-pointer whitespace-nowrap"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Configuration</span>
                  </button>
                  <button
                    type="button"
                    data-testid="options-reload-config-btn"
                    onClick={handleReloadSavedConfig}
                    className="px-3 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded cursor-pointer whitespace-nowrap"
                  >
                    Reload Saved
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wb-opt-objective"
                  className="text-xs font-semibold text-slate-200"
                >
                  Project Engineering Objective
                </label>
                <textarea
                  id="wb-opt-objective"
                  data-testid="options-input-objective"
                  rows={2}
                  value={formObjective}
                  onChange={(e) => handleObjectiveChange(e.target.value)}
                  className={EDITABLE_INPUT_CLASS}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wb-opt-context"
                  className="text-xs font-semibold text-slate-200"
                >
                  Pinned Project JARVIS Context (Initial Context — Never Invent Unverified Repository State)
                </label>
                <textarea
                  id="wb-opt-context"
                  data-testid="options-input-context"
                  rows={6}
                  value={formContext}
                  onChange={(e) => handleContextChange(e.target.value)}
                  className={EDITABLE_MONO_INPUT_CLASS}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wb-opt-milestone"
                  className="text-xs font-semibold text-slate-200"
                >
                  Active Milestone Target (Synchronized with Queue Head &amp; Next Planned Action on Save)
                </label>
                <input
                  id="wb-opt-milestone"
                  data-testid="options-input-milestone"
                  type="text"
                  value={formMilestone}
                  onChange={(e) => handleMilestoneChange(e.target.value)}
                  className={EDITABLE_INPUT_CLASS}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="wb-opt-pending-tasks"
                  className="text-xs font-semibold text-slate-200"
                >
                  Pending Milestones Queue (One well-defined task per line; Line 1 is the Active Task)
                </label>
                <textarea
                  id="wb-opt-pending-tasks"
                  data-testid="options-input-pending-tasks"
                  rows={4}
                  value={formPendingTasks}
                  onChange={(e) => handlePendingTasksChange(e.target.value)}
                  className={EDITABLE_MONO_INPUT_CLASS}
                />
              </div>

              {/* Visually Distinguished Read-Only Derived Readout */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-400">
                    Derived Next Planned Action
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">
                    READ-ONLY · DERIVED FROM CANONICAL ACTIVE TASK
                  </span>
                </div>
                <div
                  data-testid="options-readout-next-action"
                  aria-readonly="true"
                  className={READONLY_DERIVED_BOX_CLASS}
                >
                  {canonicalNextAction}
                </div>
              </div>

              <div className="p-4 bg-slate-900/55 border border-dashed border-slate-700/80 rounded-md flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200">
                    Future Local Coding Agent Integration Point (<code className="font-mono text-sky-400">local-agent-bridge.js</code>)
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">READ-ONLY STATUS</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Status: <strong className="text-slate-200 font-mono">DISABLED_BY_DEFAULT (Mode: {checkpoint.localAgentBridgeConfig?.mode || 'NONE'})</strong>.
                  This extension does not grant ChatGPT direct Windows 11 filesystem or pytest execution access. The modular <code className="font-mono">LocalAgentBridge</code> interface is preserved for future local JARVIS executor handoff.
                </p>
              </div>
            </section>

            <div className="lg:col-span-5 flex flex-col gap-6">
              {/* Section 02: All Execution Mode, Turn/Runtime/Delay, and Retry Settings */}
              <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-4">
                <h2 className="text-base font-bold text-slate-50 font-display pb-2 border-b border-slate-800">
                  02. Execution Mode, Limits &amp; Retry Boundaries
                </h2>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="wb-opt-mode"
                      className="text-xs font-semibold text-slate-300"
                    >
                      Default Operation Mode
                    </label>
                    <select
                      id="wb-opt-mode"
                      data-testid="options-select-mode"
                      value={formMode}
                      onChange={(e) =>
                        handleModeChange(e.target.value as 'SUPERVISED' | 'AUTONOMOUS')
                      }
                      className={EDITABLE_SELECT_CLASS}
                    >
                      <option value="SUPERVISED" className="bg-slate-900">
                        Supervised Mode (Default)
                      </option>
                      <option value="AUTONOMOUS" className="bg-slate-900">
                        Bounded Autonomous Mode
                      </option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="wb-opt-max-turns"
                      className="text-xs font-semibold text-slate-300"
                    >
                      Max Turns Per Session
                    </label>
                    <input
                      id="wb-opt-max-turns"
                      data-testid="options-input-max-turns"
                      type="number"
                      min={1}
                      max={100}
                      value={formMaxTurns}
                      onChange={(e) => {
                        setFormMaxTurns(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className={EDITABLE_MONO_INPUT_CLASS}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="wb-opt-max-runtime"
                      className="text-xs font-semibold text-slate-300"
                    >
                      Max Runtime (Minutes)
                    </label>
                    <input
                      id="wb-opt-max-runtime"
                      data-testid="options-input-max-runtime"
                      type="number"
                      min={1}
                      max={1440}
                      value={formMaxRuntimeMin}
                      onChange={(e) => {
                        setFormMaxRuntimeMin(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className={EDITABLE_MONO_INPUT_CLASS}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="wb-opt-prompt-delay"
                      className="text-xs font-semibold text-slate-300"
                    >
                      Prompt Delay (Seconds)
                    </label>
                    <input
                      id="wb-opt-prompt-delay"
                      data-testid="options-input-prompt-delay"
                      type="number"
                      min={1}
                      max={600}
                      value={formPromptDelaySec}
                      onChange={(e) => {
                        setFormPromptDelaySec(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className={EDITABLE_MONO_INPUT_CLASS}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="wb-opt-max-retries"
                      className="text-xs font-semibold text-slate-300"
                    >
                      Max Bounded Retries
                    </label>
                    <input
                      id="wb-opt-max-retries"
                      data-testid="options-input-max-retries"
                      type="number"
                      min={1}
                      max={10}
                      value={formMaxRetries}
                      onChange={(e) => {
                        setFormMaxRetries(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className={EDITABLE_MONO_INPUT_CLASS}
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="wb-opt-backoff-base"
                      className="text-xs font-semibold text-slate-300"
                    >
                      Backoff Base (ms)
                    </label>
                    <input
                      id="wb-opt-backoff-base"
                      data-testid="options-input-backoff-base"
                      type="number"
                      min={500}
                      max={30000}
                      value={formBackoffBaseMs}
                      onChange={(e) => {
                        setFormBackoffBaseMs(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className={EDITABLE_MONO_INPUT_CLASS}
                    />
                  </div>
                </div>

                <div className="flex items-start gap-2.5 text-xs text-slate-300 pt-1">
                  <input
                    id="wb-opt-wake-lock"
                    data-testid="options-input-wake-lock"
                    type="checkbox"
                    checked={formWakeLock}
                    onChange={(e) => {
                      setFormWakeLock(e.target.checked);
                      setHasUnsavedChanges(true);
                    }}
                    className="mt-0.5 cursor-pointer"
                  />
                  <label
                    htmlFor="wb-opt-wake-lock"
                    className="leading-relaxed text-slate-400 cursor-pointer"
                  >
                    Request Screen Wake Lock when supported (Cannot guarantee Windows 11 will stay awake or prevent OS sleep, browser restarts, or network drops).
                  </label>
                </div>
              </section>

              {/* Section 03: Checkpoint JSON Inspection, Paste/File Import & Recovery */}
              <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <h2 className="text-base font-bold text-slate-50 font-display">
                    03. Versioned Checkpoint Inspection &amp; Recovery
                  </h2>
                  <button
                    type="button"
                    data-testid="stage-v1-sample-btn"
                    onClick={handleStageSampleV1Migration}
                    className="text-xs font-semibold text-sky-400 hover:text-sky-300 cursor-pointer"
                  >
                    Stage Legacy v1 &rarr; v2 Sample
                  </button>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  Choose a <code className="font-mono text-slate-300">.json</code> checkpoint file or edit/paste JSON directly below. Clicking <strong>Validate &amp; Preview JSON</strong> validates the payload without overwriting your active checkpoint until you explicitly confirm.
                </p>

                {/* File Input Control */}
                <div className="p-3 bg-[#0B0F17] border border-dashed border-slate-700 rounded-md flex flex-col gap-2">
                  <label
                    htmlFor="workbenchCheckpointFileInput"
                    className="flex items-center gap-2 text-xs font-semibold text-sky-400 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Choose Checkpoint JSON File (.json)</span>
                  </label>
                  <input
                    ref={fileInputRef}
                    id="workbenchCheckpointFileInput"
                    data-testid="input-checkpoint-file"
                    type="file"
                    accept=".json,application/json"
                    onChange={handleFilePickerChange}
                    className="text-xs text-slate-400 file:mr-3 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700 cursor-pointer"
                  />
                  <span className="text-[11px] font-mono text-slate-500">
                    {selectedImportFileName
                      ? `Loaded: ${selectedImportFileName}`
                      : 'No file selected (or type/paste JSON manually below)'}
                  </span>
                </div>

                {/* Raw JSON Textarea */}
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="wb-opt-checkpoint-json"
                    className="text-xs font-semibold text-slate-200"
                  >
                    Checkpoint JSON Payload (Editable / Paste Target)
                  </label>
                  <textarea
                    id="wb-opt-checkpoint-json"
                    data-testid="input-checkpoint-json"
                    rows={8}
                    value={rawCheckpointJson}
                    onChange={(e) => {
                      setRawCheckpointJson(e.target.value);
                      setIsJsonDirty(true);
                    }}
                    className={EDITABLE_MONO_INPUT_CLASS}
                  />
                </div>

                {/* Actionable Import Validation Error Alert */}
                {importError && (
                  <div
                    role="alert"
                    data-testid="import-error-banner"
                    className="p-3 bg-red-950/40 border border-red-800/70 rounded-md flex flex-col gap-1 text-xs"
                  >
                    <div className="font-mono font-semibold text-red-300">
                      [{importError.code}] Checkpoint Import Rejected
                    </div>
                    <p className="text-red-200 leading-relaxed">{importError.message}</p>
                    <span className="text-[11px] text-slate-400">
                      Existing stored checkpoint ({checkpoint.sessionId}) was preserved unchanged.
                    </span>
                  </div>
                )}

                {/* Staged Import Preview & Confirmation Box */}
                {stagedImportResult && stagedImportResult.ok && (
                  <div
                    role="region"
                    aria-label="Checkpoint Import Preview"
                    data-testid="import-preview-panel"
                    className="p-3.5 bg-sky-950/30 border border-sky-700/60 rounded-md flex flex-col gap-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between pb-2 border-b border-sky-800/50">
                      <span className="font-semibold text-sky-200">
                        Staged Checkpoint Preview (Awaiting Confirmation)
                      </span>
                      <span className="font-mono text-[11px] text-sky-400">
                        {stagedImportResult.preview.migratedFromVersion
                          ? `Schema v${stagedImportResult.preview.schemaVersion} (from v${stagedImportResult.preview.migratedFromVersion})`
                          : `Schema v${stagedImportResult.preview.schemaVersion}`}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                      <div>
                        <span className="text-slate-400">Session ID: </span>
                        <code className="font-mono text-slate-100">
                          {stagedImportResult.preview.sessionId}
                        </code>
                      </div>
                      <div>
                        <span className="text-slate-400">Session State: </span>
                        <code className="font-mono text-emerald-300">
                          {stagedImportResult.preview.originalState !==
                          stagedImportResult.preview.state
                            ? `${stagedImportResult.preview.state} (from ${stagedImportResult.preview.originalState})`
                            : stagedImportResult.preview.state}
                        </code>
                      </div>
                      <div>
                        <span className="text-slate-400">Mode: </span>
                        <code className="font-mono text-slate-100">
                          {stagedImportResult.preview.operationMode}
                        </code>
                      </div>
                      <div>
                        <span className="text-slate-400">Turns: </span>
                        <code className="font-mono text-slate-100">
                          {stagedImportResult.preview.turnCount} /{' '}
                          {stagedImportResult.preview.maxTurns}
                        </code>
                      </div>
                      <div>
                        <span className="text-slate-400">Pending Tasks: </span>
                        <code className="font-mono text-slate-100">
                          {stagedImportResult.preview.pendingTaskCount}
                        </code>
                      </div>
                      <div>
                        <span className="text-slate-400">Unresolved Lock: </span>
                        <code className="font-mono text-slate-100">
                          {stagedImportResult.preview.unresolvedSubmissionStatus}
                        </code>
                      </div>
                      <div className="col-span-2 pt-1">
                        <span className="text-slate-400 block">Active Milestone:</span>
                        <div className="font-mono text-slate-200 bg-[#0B0F17] border border-slate-800 rounded px-2 py-1 mt-0.5">
                          {stagedImportResult.preview.currentMilestone}
                        </div>
                      </div>
                      <div className="col-span-2">
                        <span className="text-slate-400 block">Next Proposed Action:</span>
                        <div className="font-mono text-sky-300 bg-[#0B0F17] border border-slate-800 rounded px-2 py-1 mt-0.5">
                          {stagedImportResult.preview.nextProposedAction}
                        </div>
                      </div>
                    </div>

                    {stagedImportResult.preview.warnings?.length > 0 && (
                      <div className="p-2 bg-amber-950/40 border border-amber-700/50 rounded text-[11px] text-amber-200">
                        {stagedImportResult.preview.warnings.join(' ')}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        data-testid="confirm-checkpoint-import-btn"
                        onClick={handleConfirmCheckpointImport}
                        disabled={isCommittingImport}
                        className="px-3 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded cursor-pointer"
                      >
                        {isCommittingImport
                          ? 'Committing...'
                          : 'Confirm & Commit Checkpoint Import'}
                      </button>
                      <button
                        type="button"
                        data-testid="cancel-checkpoint-import-btn"
                        onClick={handleCancelCheckpointImport}
                        className="px-3 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded cursor-pointer"
                      >
                        Cancel Staged Import
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="validate-preview-json-btn"
                    onClick={handleStageManualJsonImport}
                    className="px-3 py-1.5 text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white rounded cursor-pointer"
                  >
                    Validate &amp; Preview JSON
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadCheckpointJson}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded cursor-pointer"
                  >
                    Download Checkpoint JSON
                  </button>
                  <button
                    type="button"
                    data-testid="reset-session-progress-btn"
                    onClick={() => handleResetSession(false)}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded cursor-pointer"
                  >
                    Reset Session Progress
                  </button>
                  <button
                    type="button"
                    data-testid="restore-factory-defaults-btn"
                    onClick={() => handleResetSession(true)}
                    className="px-3 py-1.5 text-xs font-semibold bg-red-600/90 hover:bg-red-600 text-white rounded cursor-pointer"
                  >
                    Restore Factory Defaults
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}

        {/* TAB 3: AUTOMATED TEST SUITE & VERIFICATION REPORT */}
        {activeTab === 'tests' && (
          <div className="flex flex-col gap-6">
            <section className="bg-[#111827] border border-slate-800 rounded-lg p-6 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-800">
                <div>
                  <h2 className="text-lg font-bold text-slate-50 font-display">
                    Automated Verification Suite (<code className="text-sm font-mono text-sky-400">tests/extension.test.js</code>)
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Executes directly against the canonical extension modules with mocked Chrome APIs and ChatGPT DOM fixtures
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  {testSummary && (
                    <div className="text-sm font-mono font-semibold text-emerald-400 tabular-nums">
                      {testSummary.passed} / {testSummary.total} Tests Passed ({testSummary.failed} Failed)
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleRunTestSuite}
                    disabled={isRunningTests}
                    className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-sky-600 hover:bg-sky-500 rounded cursor-pointer whitespace-nowrap"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRunningTests ? 'animate-spin' : ''}`} />
                    <span>
                      {isRunningTests
                        ? 'Running Suite...'
                        : `Re-Run All ${testSummary?.total || 19} Tests`}
                    </span>
                  </button>
                </div>
              </div>

              {/* High-Density Test Results Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                      <th className="py-2.5 px-3">ID</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Category</th>
                      <th className="py-2.5 px-3">Verified Invariant / Behavior</th>
                      <th className="py-2.5 px-3 text-right">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {(testSummary?.results || []).map((r) => (
                      <tr key={r.id} className="hover:bg-slate-800/30">
                        <td className="py-2.5 px-3 font-mono text-slate-400 tabular-nums">
                          {r.id}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-semibold">
                          {r.passed ? (
                            <span className="text-emerald-400 flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              PASS
                            </span>
                          ) : (
                            <span className="text-red-400 flex items-center gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              FAIL
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-slate-200 whitespace-nowrap">
                          {r.category}
                        </td>
                        <td className="py-2.5 px-3 text-slate-300">
                          {r.title}
                          {r.error && (
                            <div className="text-red-400 font-mono mt-1">{r.error}</div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-slate-400 tabular-nums">
                          {r.durationMs}ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Transparent Verification Boundary Comparison */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
                <h3 className="text-sm font-bold text-emerald-400 font-display">
                  Verified in Automated Test Runner (Node.js &amp; Browser Harness)
                </h3>
                <ul className="text-xs text-slate-300 space-y-2 list-disc pl-4">
                  <li>All 12 state machine transitions &amp; illegal transition rejection.</li>
                  <li>Single Unresolved Submission Invariant lock (<code className="font-mono">unresolvedSubmission !== null</code>).</li>
                  <li>Interactive UI field focus, typing retention without clobbering, Save Configuration persistence, and page-reload verification.</li>
                  <li>Canonical Active-Task synchronization across <code className="font-mono">currentMilestone</code>, <code className="font-mono">pendingTasks[0]</code>, <code className="font-mono">nextProposedAction</code>, and <code className="font-mono">stagedPrompt</code>.</li>
                  <li>Two-stage Checkpoint JSON file/paste import with preview, safety state clamping, legacy v1 &rarr; v2 migration, and invalid JSON rejection.</li>
                  <li>Multi-poll response stability verification (<code className="font-mono">stablePolls &gt;= 3</code>) and immediate Emergency Stop lockout.</li>
                </ul>
              </section>

              <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
                <h3 className="text-sm font-bold text-amber-400 font-display">
                  Requires Local Windows 11 Chrome Browser Verification
                </h3>
                <ul className="text-xs text-slate-300 space-y-2 list-disc pl-4">
                  <li>Loading the unpacked extension via <code className="font-mono">chrome://extensions</code> in your desktop Chrome instance.</li>
                  <li>Authenticated DOM interaction against live <code className="font-mono">https://chatgpt.com/</code> sessions under your OpenAI account.</li>
                  <li>Live <code className="font-mono">navigator.wakeLock</code> acquisition under Windows 11 power management settings.</li>
                  <li>Real-world resilience against future unannounced OpenAI CSS/DOM layout changes.</li>
                </ul>
              </section>
            </div>
          </div>
        )}

        {/* TAB 4: EXTENSION PACKAGE & WINDOWS 11 INSTALLATION GUIDE */}
        {activeTab === 'package' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left 5 Cols: File Tree & Windows 11 9-Step Guide */}
            <div className="lg:col-span-5 flex flex-col gap-6">
              <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
                <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                  <h2 className="text-base font-bold text-slate-50 font-display">
                    Canonical Extension Files (<code className="text-xs font-mono text-sky-400">/public/extension/</code>)
                  </h2>
                  <button
                    type="button"
                    onClick={handleDownloadExtensionZip}
                    className="text-xs font-semibold text-sky-400 hover:text-sky-300 cursor-pointer"
                  >
                    Export Root ZIP
                  </button>
                </div>

                <div className="divide-y divide-slate-800/60">
                  {EXTENSION_FILES_MANIFEST.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setSelectedFilePath(f.path)}
                      className={`w-full py-2 px-2.5 text-left flex items-center justify-between gap-3 rounded transition-colors cursor-pointer ${
                        selectedFilePath === f.path
                          ? 'bg-sky-950/50 text-sky-300'
                          : 'hover:bg-slate-800/40 text-slate-300'
                      }`}
                    >
                      <span className="font-mono text-xs font-medium shrink-0">
                        {f.path}
                      </span>
                      <span className="text-[11px] text-slate-400 truncate">
                        {f.role}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
                <h2 className="text-base font-bold text-slate-50 font-display pb-2 border-b border-slate-800">
                  Windows 11 Installation &amp; Smoke Test Steps
                </h2>
                <ol className="text-xs text-slate-300 space-y-2.5 list-decimal pl-4 leading-relaxed">
                  <li>
                    <strong>Export Extension Archive</strong>: Click <strong>Download MV3 Extension (.zip)</strong> and extract it to a folder on Windows 11 (confirm <code className="font-mono text-sky-300">manifest.json</code> is at the root of that folder).
                  </li>
                  <li>
                    <strong>Open Extensions Page</strong>: Navigate to <code className="font-mono text-sky-300">chrome://extensions/</code> in Google Chrome.
                  </li>
                  <li>
                    <strong>Enable Developer Mode</strong>: Toggle <strong>Developer mode</strong> ON in the top-right corner.
                  </li>
                  <li>
                    <strong>Load Unpacked</strong>: Click <strong>Load unpacked</strong> in the top-left bar.
                  </li>
                  <li>
                    <strong>Select Root Folder</strong>: Select the extracted folder containing <code className="font-mono text-sky-300">manifest.json</code>.
                  </li>
                  <li>
                    <strong>Open ChatGPT</strong>: Navigate to <code className="font-mono text-sky-300">https://chatgpt.com/</code> and click the JARVIS Auto-Pilot icon in your Chrome toolbar.
                  </li>
                  <li>
                    <strong>Run Supervised Smoke Test</strong>: Leave mode on <strong>Supervised</strong>, set <strong>Max Turns = 2</strong>, click <strong>Start Session</strong>, and click <strong>Approve &amp; Send Turn</strong>.
                  </li>
                  <li>
                    <strong>Inspect Checkpoint &amp; Log</strong>: Click <strong>Settings</strong> in the popup to inspect or import/export the versioned Schema v2 checkpoint in <code className="font-mono text-sky-300">options.html</code>.
                  </li>
                  <li>
                    <strong>Emergency Stop Verification</strong>: Click <strong>Emergency Stop</strong> and confirm the state immediately locks in <code className="font-mono text-red-400">STOPPED</code>.
                  </li>
                </ol>
              </section>
            </div>

            {/* Right 7 Cols: Live Source File Viewer */}
            <section className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-lg p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <FileCode className="w-4 h-4 text-sky-400" />
                  <span className="font-mono text-sm font-semibold text-slate-100">
                    /public/extension/{selectedFilePath}
                  </span>
                </div>
                <span className="text-xs text-slate-400">
                  Included at root of exported ZIP
                </span>
              </div>

              <pre className="p-4 bg-[#0B0F17] border border-slate-800 rounded-md text-xs font-mono text-slate-200 overflow-x-auto max-h-[680px] overflow-y-auto leading-relaxed">
                {loadingFile ? 'Loading source file...' : selectedFileContent}
              </pre>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
