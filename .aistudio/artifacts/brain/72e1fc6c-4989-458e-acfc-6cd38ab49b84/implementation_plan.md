# JARVIS Auto-Pilot — Chrome Extension (Manifest V3) & Engineering Workbench

JARVIS Auto-Pilot is a real, installable Google Chrome Extension (Manifest V3) built in pure Vanilla JavaScript, HTML, and CSS that automates long-duration Project JARVIS engineering sessions at `https://chatgpt.com/`. Alongside the standalone extension, the Google AI Studio Engineering Workbench directly imports and executes the **single canonical JavaScript extension modules** to configure, test, simulate, and export a ready-to-load standalone extension `.zip` archive with `manifest.json` at its root.

## Confirmation of Core Requirements

> [!IMPORTANT]
> Explicit confirmation of your 8 architectural and operational mandates:

1. **Primary Deliverable — Real Installable MV3 Extension**: A self-contained Manifest V3 Chrome Extension targeting `https://chatgpt.com/*` using plain JavaScript, HTML, and CSS, `chrome.storage.local`, and `chrome.alarms`—requiring zero build pipeline to load unpacked in Chrome.
2. **Secondary Deliverable — AI Studio Engineering Workbench**: An interactive engineering harness hosted in the AI Studio preview that configures checkpoints, runs the automated test suite, simulates ChatGPT DOM states, inspects the live Popup/Options views, and exports the extension package.
3. **Single Canonical JavaScript Implementation**: `storage.js`, `session-controller.js`, `dom-adapter.js`, `background.js`, `content.js`, `popup.js`, and `options.js` exist as a **single canonical source of truth**. The AI Studio Workbench and automated test suite import and execute these exact vanilla JS modules directly—zero duplicate implementations or React rewrites of extension logic.
4. **Safety & Reliability Primitives**: Enforces versioned persistent checkpoints (`v1` $\rightarrow$ `v2` schema migration), strict duplicate-submission prevention (at most one unresolved automated submission per session), fail-closed recovery on restart/ambiguity, **Supervised Mode by default**, bounded autonomous execution (`maxTurns`, `maxRuntimeMs`, `promptDelayMs`), and an immediate **Emergency Stop** lockout.
5. **Future Local Coding Agent Integration Point**: Includes an explicit, modular `LocalAgentBridge` adapter interface (`local-agent-bridge.js` / hook inside `session-controller.js`) disabled by default (`mode: "NONE"`), preserving a clean protocol boundary (`chrome.runtime.sendNativeMessage` or localhost loopback webhook) for future Windows 11 local JARVIS agent handoff without replacing or complicating the current ChatGPT extension.
6. **Strict Verification Transparency**: Explicitly separates automated unit/integration tests executed against mocked Chrome APIs and simulated DOM structures from real Chrome + live `chatgpt.com` browser verification steps that must be run locally on Windows 11.
7. **Root-Level `manifest.json` ZIP Export**: The one-click ZIP exporter packages the standalone extension files so that `manifest.json` sits at the root of the archive, ready for `chrome://extensions` $\rightarrow$ `Load unpacked`.
8. **Untouched Local JARVIS Repository**: Treats your Windows 11 Project JARVIS repository as external, read-only user context. Never invents local source files, test outputs, or repository mutations.

---

## 1. Final System Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│              CANONICAL EXTENSION CORE (Vanilla JS — Single Source of Truth)            │
├──────────────────────────┬────────────────────────────┬────────────────────────────────┤
│    Extension UI Views    │   Controller & Memory      │    Page & Bridge Adapters      │
│                          │                            │                                │
│  ┌────────────────────┐  │  ┌──────────────────────┐  │  ┌──────────────────────────┐  │
│  │ Popup Console      │  │  │ Session Controller   │  │  │ ChatGPT DOM Adapter      │  │
│  │ (popup.html/css/js)├──┼─►│ (session-controller) ├─┼─►│ (dom-adapter.js)         │  │
│  └────────────────────┘  │  │  • 12-State Machine  │  │  │  • Multi-selector lookup │  │
│                          │  │  • 1-Submission Lock │  │  │  • Submission verifier   │  │
│  ┌────────────────────┐  │  │  • Prompt Policy Gen │  │  │  • 4-Signal completion   │  │
│  │ Options Studio     │  │  │  • Milestone Parser  │  │  │  • Continue/Limit checks │  │
│  │ (options.html/.js) ├──┼─►└──────────┬───────────┘  │  └──────────────────────────┘  │
│  └────────────────────┘  │             │              │                                │
│                          │  ┌──────────▼───────────┐  │  ┌──────────────────────────┐  │
│  ┌────────────────────┐  │  │ Versioned Storage    │  │  │ Local Agent Bridge Stub  │  │
│  │ Service Worker     │  │  │ (storage.js)         │  │  │ (Future Integration Hook)│  │
│  │ (background.js)    ├──┼─►│  • Schema Validation │  │  │  • Disabled by default   │  │
│  │  • chrome.alarms   │  │  │  • v1 -> v2 Migrate  │  │  │  • Fail-closed boundary  │  │
│  └────────────────────┘  │  └──────────────────────┘  │  └──────────────────────────┘  │
└─────────────┬────────────┴─────────────┬──────────────┴────────────────┬───────────────┘
              │                          │                               │
              ▼                          ▼                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│           DELIVERABLE 1: Standalone Chrome Extension Package & Root ZIP Export         │
│       Loads directly into chrome://extensions (Manifest V3) on https://chatgpt.com     │
└────────────────────────────────────────────────────────────────────────────────────────┘
              │                          │                               │
              ▼                          ▼                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│           DELIVERABLE 2: Google AI Studio Engineering Workbench & Test Runner          │
│   Executes the exact canonical JS files above against mocked Chrome APIs & DOM fixtures│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Explicit 12-State Machine & Single-Submission Invariant

- **States**: `IDLE`, `READY`, `SUBMITTING`, `GENERATING`, `RESPONSE_COMPLETE`, `CONTINUING`, `PAUSED`, `WAITING_FOR_APPROVAL`, `INTERRUPTED`, `ERROR`, `STOPPED`, `COMPLETED`.
- **Single Unresolved Submission Invariant**: Before entering `SUBMITTING`, `SessionController` writes `unresolvedSubmission = { turnId, promptHash, promptText, timestamp, verifiedInDom: false }` to `chrome.storage.local`. A second submission is structurally impossible while `unresolvedSubmission !== null`. Only after `ChatGPTDomAdapter.verifySubmission()` confirms the prompt in the active conversation DOM does it clear the unverified flag and transition to `GENERATING`. If recovery encounters an unverified submission whose presence on the page is uncertain, it transitions immediately to `INTERRUPTED` and awaits human confirmation.
- **Future Local Coding Agent Hook**: `SessionController` exposes an optional `agentBridge` interface (`onMilestoneComplete(checkpointSummary)` and `requestToolVerification(actionProposal)`). In v1, this defaults to a no-op fail-closed stub that reminds the prompt generator that ChatGPT has no direct filesystem access unless verified external output is pasted or bridged by the operator.

---

## 2. Project & Extension Structure

All standalone Chrome Extension files live in `public/extension/` so they can be served as raw static files, imported directly by the test suite and workbench without transpilation, and bundled into a flat root-level `.zip` where `manifest.json` is at the archive root:

- **Standalone Manifest V3 Extension (`public/extension/` $\rightarrow$ Root of exported `.zip`)**:
  - `manifest.json` — Manifest V3 declaration (`storage`, `alarms`, `activeTab`, `scripting`, host permission restricted strictly to `https://chatgpt.com/*`).
  - `storage.js` — Canonical versioned checkpoint store, schema validator, `v1` $\rightarrow$ `v2` migrator, and atomic state persistence.
  - `session-controller.js` — Canonical 12-state machine, single-submission invariant guard, JARVIS 7-point continuation prompt builder, dual-stage Markdown/heuristic milestone parser, bounded exponential backoff, and future local-agent hook.
  - `dom-adapter.js` — Canonical isolated ChatGPT DOM adapter with multi-selector fallback arrays, composer input dispatcher, submission verifier, 4-signal completion stability observer, `Continue generating` verifier, and rate-limit/auth challenge detectors.
  - `background.js` — MV3 service worker orchestrating `chrome.alarms` recovery ticks, message routing between popup/options/content scripts, wake-lock coordination, and service-worker restart recovery.
  - `content.js` — Content script entry point injected on `https://chatgpt.com/*` that binds `ChatGPTDomAdapter` to `SessionController` and handles page navigation/mutation events safely.
  - `popup.html`, `popup.css`, `popup.js` — Standalone dark engineering console popup connected to live `chrome.storage.local` and `chrome.runtime` messages.
  - `options.html`, `options.css`, `options.js` — Standalone full-page configuration studio for long JARVIS instructions, milestone queue management, limits, and checkpoint JSON import/export.
  - `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` — Extension icons required by Chrome Manifest V3.
  - `README.md` — Complete Windows 11 installation, smoke testing, recovery, and verification guide included inside the extension root.
- **Automated Test Suite (`tests/`)**:
  - `extension.test.js` — Comprehensive automated test suite importing the canonical `public/extension/*.js` modules and verifying all 16 required behavioral categories against mocked Chrome APIs and simulated ChatGPT DOM fixtures.
- **AI Studio Engineering Workbench (`src/`)**:
  - Hosts the live Popup & Options hardware inspector, Interactive ChatGPT DOM Simulator wired to the canonical JS modules, Live Automated Test Runner with real execution output, and One-Click Root-Level Extension `.zip` Exporter.

---

## 3. Visual Design & Ergonomics

- **Aesthetic Direction**: High-precision Dark Engineering Console (`#0B0F17` canvas, `#111827` structural panels, `#1E293B` `1px solid` borders, `#0284C7` primary action accent, `#16A34A` nominal, `#D97706` supervised/warning, `#DC2626` emergency stop/error).
- **Typography**: `Plus Jakarta Sans` for headings and navigation, `Public Sans` for dense UI controls, and `JetBrains Mono` (`tabular-nums`) for turn counters, runtime clocks, retry backoffs, and checkpoint JSON inspection.
- **Strict Anti-Slop & Zero-Pill Discipline**: Unboxed inline metadata separated by `·`, single-elevation surfaces, plain human control labels (`Start Session`, `Approve & Send`, `Pause`, `Resume`, `Emergency Stop`), and strict 3-zone Top Bar Contract in the workbench (`JARVIS Auto-Pilot` wordmark — 4 single-line view links — `Download Extension (.zip)` primary button).

---

## 4. Development Milestones

1. **Milestone 1 — Canonical Storage & Checkpoint Engine (`storage.js`)**:
   - Implement schema v2 validation, v1-to-v2 migration, default Windows 11 Project JARVIS context initialization, and corruption-safe recovery.
2. **Milestone 2 — Explicit 12-State Controller & Guardrails (`session-controller.js`)**:
   - Implement permitted state transition matrix, single unresolved submission invariant, JARVIS 7-step continuation prompt generator, Markdown/heuristic response parser, turn/runtime/delay limits, exponential backoff, emergency stop lockout, and future local-agent hook stub.
3. **Milestone 3 — Defensive ChatGPT DOM Adapter (`dom-adapter.js` & `content.js`)**:
   - Implement multi-strategy selector arrays for composer, send/stop buttons, assistant messages, `Continue generating` verification, rate-limit/auth banners, and multi-poll response stability checking.
4. **Milestone 4 — MV3 Service Worker & Standalone Extension UI (`manifest.json`, `background.js`, `popup.*`, `options.*`, `README.md`)**:
   - Wire `chrome.alarms` recovery, message passing, wake-lock handling, and full functional controls across `popup.html` and `options.html`.
5. **Milestone 5 — Automated Test Suite & Engineering Workbench (`tests/`, `src/`)**:
   - Build the 16-category automated test suite, execute it via Node and in-browser runner, wire the live ChatGPT DOM simulator and ZIP packager (guaranteeing `manifest.json` at the ZIP root), and verify zero build or test errors.

---

## 5. Acceptance Criteria

- **AC-1 (Valid Manifest V3 Root Package)**: Exported `.zip` extracts with `manifest.json` at the root directory, valid icons, restricted `https://chatgpt.com/*` host permissions, and every file path present and loadable via `chrome://extensions` $\rightarrow$ `Load unpacked`.
- **AC-2 (Canonical Single Implementation)**: The extension files in `public/extension/` are pure Vanilla JS/HTML/CSS and are the exact same files executed by the automated tests and AI Studio Workbench simulator.
- **AC-3 (Single Unresolved Submission Invariant)**: Attempting to trigger a second submission while a prompt is in `SUBMITTING` or unverified in the DOM is rejected by the state machine and covered by automated tests.
- **AC-4 (Supervised Default & Bounded Autonomy)**: New sessions initialize in `SUPERVISED` mode (`WAITING_FOR_APPROVAL` before each turn) and enforce `maxTurns`, `maxRuntimeMs`, and `promptDelayMs` in both modes.
- **AC-5 (Emergency Stop Immediate Lockout)**: Clicking **Emergency Stop** from any state transitions immediately to `STOPPED`, cancels active timers/alarms, and prevents any automated DOM action until manually reset.
- **AC-6 (16-Category Automated Test Pass)**: All 16 required test categories pass with real execution results reported transparently, clearly separated from real-browser smoke tests on `chatgpt.com`.

---

## 6. Unresolved Risks & Operational Limitations

> [!WARNING]
> Transparent engineering disclosure of inherent browser and platform constraints:

1. **ChatGPT DOM Evolution Risk**: OpenAI frequently updates `chatgpt.com` class names and DOM hierarchy. While `ChatGPTDomAdapter` mitigates this using multi-tier selectors (`data-testid`, ARIA roles, semantic structure) and custom selector overrides in `options.html`, major layout overhauls will cause the adapter to fail closed (`PAUSED` / `INTERRUPTED`) rather than guessing selectors.
2. **Hermetic Sandbox vs. Live `chatgpt.com` Verification**: Google AI Studio runs in a cloud container and cannot log into your personal authenticated `chatgpt.com` account. Therefore, while all state transitions, storage migrations, DOM adapter logic (against realistic ChatGPT HTML fixtures), and Chrome API interactions are verified via automated tests here, final live browser verification must be performed locally on your Windows 11 machine using the provided 9-step smoke test in `README.md`.
3. **OS Sleep & Overnight Interruptions**: The Web `navigator.wakeLock` API (when permitted on a visible tab) helps prevent display sleep, but cannot override Windows 11 group policies, mandatory OS updates, network drops, or ChatGPT usage caps. The extension is therefore architected for **safe checkpoint recovery** rather than promising uninterrupted overnight execution.
4. **No Direct Local Filesystem Execution**: The Chrome extension operates inside Chrome's sandbox and cannot directly inspect your local Windows 11 JARVIS repository or run `pytest` unless paired with the future `LocalAgentBridge`. Prompts explicitly instruct ChatGPT not to fabricate local file changes or test runs.
