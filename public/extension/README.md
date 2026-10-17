# JARVIS Auto-Pilot — Chrome Extension (Manifest V3)

**JARVIS Auto-Pilot** is a self-contained, installable Google Chrome Extension (Manifest V3) engineered for running long-duration **Project JARVIS** engineering sessions through the ChatGPT web interface (`https://chatgpt.com/`) on Windows 11 with persistent versioned checkpoints, an explicit 12-state machine, duplicate-submission prevention, and fail-closed recovery.

---

## 1. Extension File Structure (Root of Unpacked Extension)

Every path in `manifest.json` resolves directly to these standalone Vanilla JavaScript, HTML, and CSS files:

- `manifest.json` — Chrome Extension Manifest V3 configuration (`storage`, `alarms`, `activeTab`, `scripting`, host access restricted to `https://chatgpt.com/*`).
- `storage.js` — Versioned checkpoint engine (`Schema v2`), `v1 -> v2` schema migration, validation, and secret redaction.
- `session-controller.js` — Explicit 12-state machine (`IDLE`, `READY`, `SUBMITTING`, `GENERATING`, `RESPONSE_COMPLETE`, `CONTINUING`, `PAUSED`, `WAITING_FOR_APPROVAL`, `INTERRUPTED`, `ERROR`, `STOPPED`, `COMPLETED`), Single Unresolved Submission Invariant guard, JARVIS 7-point continuation prompt builder, and response parser.
- `dom-adapter.js` — Isolated ChatGPT DOM adapter with multi-selector fallback arrays, 4-signal completion stability verification, `Continue generating` detection, submission verification, and rate-limit/auth challenge detection.
- `local-agent-bridge.js` — Fail-closed integration hook reserved for future local Windows 11 JARVIS coding agent telemetry.
- `background.js` — Manifest V3 service worker managing `chrome.alarms` recovery ticks, restart recovery, and message routing.
- `content.js` — Content script coordinator injected on `https://chatgpt.com/*`.
- `popup.html`, `popup.css`, `popup.js` — Dark engineering console popup UI.
- `options.html`, `options.css`, `options.js` — Full-tab configuration, milestone queue, and JSON checkpoint studio.
- `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` — Extension icons.

---

## 2. Exact Windows 11 Installation Steps

1. **Export or Download the Extension Source**:
   - In the AI Studio Engineering Workbench, click **Download MV3 Extension (.zip)** in the top right bar (or extract `public/extension/` from the project archive).
   - Extract the downloaded `jarvis-autopilot-mv3-extension.zip` to a permanent folder on your Windows 11 machine, for example:
     `C:\Users\<YourUsername>\Projects\jarvis-autopilot-extension\`
   - Verify that `manifest.json` sits directly inside that folder.
2. **Open Chrome Extensions Manager**:
   - Open Google Chrome and navigate to `chrome://extensions/`.
3. **Enable Developer Mode**:
   - Toggle the **Developer mode** switch in the top-right corner of the `chrome://extensions/` page to **ON**.
4. **Click Load Unpacked**:
   - Click the **Load unpacked** button in the top-left toolbar.
5. **Select the Directory Containing `manifest.json`**:
   - Select your extracted folder (`C:\Users\<YourUsername>\Projects\jarvis-autopilot-extension\`).
   - Confirm **JARVIS Auto-Pilot** (`v1.2.0`) appears in your extensions list with zero manifest warnings or errors, and pin it to your Chrome toolbar using the puzzle-piece icon.
6. **Open ChatGPT and Verify the Extension Interface**:
   - Navigate to `https://chatgpt.com/` and sign in or open your target Project JARVIS conversation.
   - Click the **JARVIS Auto-Pilot** toolbar icon to open the popup console.
7. **Run a Supervised Smoke Test (Small Max-Turn Limit)**:
   - Keep **Mode Select** on `Supervised (Approve Each)` (the default).
   - Set **Max Turns** to `2` and **Prompt Delay (sec)** to `5`.
   - Click **Start Session**. Observe the state transition from `IDLE` $\rightarrow$ `READY` $\rightarrow$ `WAITING_FOR_APPROVAL`.
   - Click **Approve & Send Turn**. Verify that the prompt populates the ChatGPT composer, submits, is verified in the conversation DOM (`SUBMITTING` $\rightarrow$ `GENERATING`), and waits for response stability before advancing to `RESPONSE_COMPLETE` $\rightarrow$ `WAITING_FOR_APPROVAL`.
8. **Inspect the Session Checkpoint and Activity Log**:
   - Click **Settings** in the popup header to open `options.html`.
   - Review Section `03. Versioned Checkpoint Inspection & Recovery` to inspect the live `Schema v2` JSON checkpoint, `turnCount`, `completedTasks`, and `activityLog`.
9. **Stop the Session Safely**:
   - Click the red **Emergency Stop** button in the popup at any time.
   - Confirm the state immediately transitions to `STOPPED`, all background `chrome.alarms` timers are cleared, and no further automated submissions can occur until you explicitly start or reset the session.

---

## 3. Verification Matrix & Operational Boundaries

### Verified via Automated Test Suite (`tests/extension.test.js`)
- Permitted & illegal transitions across all 12 states.
- `chrome.storage.local` checkpoint persistence and validation.
- Schema migration from `v1` to `v2` preserving in-flight submission locks.
- Single Unresolved Submission Invariant (blocks any second submission while `unresolvedSubmission !== null`).
- DOM submission verification by exact FNV-1a prompt hash and Turn ID marker.
- Multi-signal response completion detection requiring consecutive stable polls (`stablePolls >= 3`) with no active Stop button or streaming indicator.
- `Continue generating` detection and bounded per-turn continuation cap.
- Bounded retry limits and exponential backoff (`2000ms`, `4000ms`, `8000ms`).
- `maxTurns` and `maxRuntimeMs` enforcement.
- Immediate Emergency Stop lockout from any state.
- Pause and Resume state recovery.
- Service worker / browser restart recovery (stops in `INTERRUPTED` when submission status is ambiguous).
- Missing or mutated DOM selector fallbacks.
- Rate-limit banner and authentication challenge detection.
- Canonical Active-Task synchronization across `currentMilestone`, `pendingTasks[0]`, `nextProposedAction`, and `stagedPrompt`.
- Two-stage Checkpoint JSON file/paste import with non-destructive preview, explicit confirmation, safety state clamping, legacy `v1 -> v2` migration, and unresolved-submission lock protection.

---

## 4. Canonical Active-Task Rule & Checkpoint JSON Import

### Canonical Active-Task Synchronization
- **Single Source of Truth**: The active task is always the head of `pendingTasks` (`pendingTasks[0].title`), kept strictly synchronized with `currentMilestone` and `nextProposedAction`.
- **Consistent Configuration Saves**: Saving in `options.js` or `popup.js` invokes `storage.saveConfiguration()`, reconciling `currentMilestone`, `pendingTasks[0]`, and `nextProposedAction` so contradictory state can never be saved.
- **Session Reset vs. Factory Reset**:
  - **Reset Session Progress** (`storage.resetCheckpoint()`) resets `turnCount`, `completedTasks`, `state`, and errors while preserving your saved objective, pinned context, and custom task queue.
  - **Restore Factory Defaults** (`storage.resetCheckpoint({ factoryReset: true })`) wipes custom settings and restores the initial factory configuration.

### Two-Stage Checkpoint JSON Import (`options.html` & Workbench)
1. **Select `.json` File or Paste JSON**: Use **Choose Checkpoint JSON File (.json)** (powered by `FileReader`) or paste JSON into the editor and click **Validate & Preview JSON**.
2. **Non-Destructive Validation & Preview**: `storage.previewCheckpointImport()` parses and validates schema version (`v2` or legacy `v1 -> v2`), required fields, field types, and session states, and displays a preview of `schemaVersion`, `state`, `operationMode`, `sessionId`, `currentMilestone`, `nextProposedAction`, `pendingTaskCount`, `turnCount`, and `unresolvedSubmissionStatus`.
3. **Safety Clamping & Lock Protection**:
   - Imports are blocked if the currently stored session has an active `unresolvedSubmission` lock (`ACTIVE_UNRESOLVED_SUBMISSION_LOCK`).
   - Imported active loop states (`READY`, `GENERATING`, `CONTINUING`, `RESPONSE_COMPLETE`) are safely clamped to `WAITING_FOR_APPROVAL` (Supervised) or `PAUSED` (Autonomous) so an import never triggers an immediate unapproved submission.
4. **Explicit Confirmation**: The checkpoint is written to `chrome.storage.local` only when you click **Confirm & Commit Checkpoint Import**.

### Remaining Limitations & Risks
- **Live Browser Verification**: Because AI Studio runs in a cloud sandbox without access to your authenticated `chatgpt.com` session, live end-to-end smoke testing on `chatgpt.com` must be completed locally on your Windows 11 machine using Steps 6–9 above.
- **Overnight Execution & Wake Lock**: While the extension requests `navigator.wakeLock` when enabled, browser wake locks cannot override Windows 11 power policies, mandatory reboots, network drops, or OpenAI usage caps. The system is designed for **safe checkpoint recovery** rather than promising uninterrupted overnight execution.
- **No Local Filesystem Mutation**: This Chrome extension does not grant ChatGPT access to your local Windows 11 disk or test runner.
