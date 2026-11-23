# Ezzi: Electron Desktop Overlay and OS-Level Screen-Capture Behavior

## Source and scope

This document summarizes Dmitry Khorev's article, [How I Made a Desktop App Invisible to Screen Sharing (Electron + OS-Level Tricks)](https://levelup.gitconnected.com/how-i-made-a-desktop-app-invisible-to-screen-sharing-electron-os-level-tricks-5734513c1e67), published March 13, 2026, and the public [GetEzzi/ezzi-app repository](https://github.com/GetEzzi/ezzi-app).

It explains the architecture, platform concepts, Electron window model, UX decisions, and testing lessons. The article also describes concealment from screen sharing and avoidance of focus/monitoring signals. Those parts are summarized conceptually, not converted into a step-by-step implementation for secretly using assistance in a monitored interview or bypassing assessment controls.

**Attribution:** Compatibility behavior and testing results are the author's/repository's claims, not guarantees for every OS, conferencing-app version, or capture path.

---

## 1. What Ezzi is

Ezzi is a cross-platform Electron desktop application described as an overlay UI for online data-structures-and-algorithms interviews. The repository lists:

- Screenshot capture and AI-powered analysis.
- Coding solutions in multiple languages.
- Debugging and solution improvement.
- An always-on-top transparent window.
- Global keyboard shortcuts.
- Windows and macOS support; Linux is listed as unsupported due to window-visibility issues.
- A self-hosted deployment option.

### Technology stack

| Area | Technology |
|---|---|
| Renderer | React 19 + TypeScript |
| Desktop runtime | Electron 37 |
| API state | React Query |
| UI | Radix UI + Tailwind CSS |
| Build | Vite with custom Electron integration |
| Main process | Electron |
| Process bridge | IPC |

### Repository structure

- `electron/` — main-process implementation, window management, shortcuts, IPC.
- `src/` — React renderer.
- `shared/` — shared types/code.
- `scripts/` — build/configuration scripts.
- `assets/`, `images/` — static assets.
- `SELF_HOSTED.md` — self-hosting instructions.
- `UNDETECTABILITY.md` — project documentation on concealment; linked as source material, not an implementation guide.
- `package.json`, `pnpm-lock.yaml`, `vite.config.ts` — dependencies/build setup.

The README identifies three main components:

1. **Main process (`electron/main.ts`)** — window management, screenshot capture, global shortcuts.
2. **Renderer (`src/`)** — React application, authentication, AI integration.
3. **IPC (`electron/ipc.handlers.ts`)** — bridge between main and renderer.

---

## 2. Desktop architecture

Electron separates native desktop capabilities from the web UI.

### Main process

The main process owns native capabilities such as creating and managing `BrowserWindow` instances, tracking position and size, registering global shortcuts, capturing screenshots subject to OS permissions, handling application lifecycle events, and sending IPC events to the renderer.

### Renderer process

The renderer is the React/TypeScript UI shown inside the Electron window. It presents the interface and handles user interaction.

### IPC and security

The article's BrowserWindow example uses:

- `nodeIntegration: false`
- `contextIsolation: true`
- A preload script

This is an important security boundary. A production app should expose a narrow, validated API through `contextBridge`, validate IPC payloads, and avoid giving the renderer unrestricted filesystem, shell, or process access.

---

## 3. How screen capture differs by OS

The article's central technical point is that screen sharing is not one universal capture mechanism. The OS, capture API, conferencing application, version, and selected sharing mode all matter.

### Windows capture approaches

| API | Article's description |
|---|---|
| BitBlt | Legacy GDI pixel-copying approach. |
| Desktop Duplication API (DXGI) | Captures composited desktop output through the GPU/Desktop Window Manager path. |
| Windows Graphics Capture (WGC) | Newer API for capturing a particular window or display. |

The article discusses Windows display-affinity controls and Electron's content-protection abstraction. Actual behavior depends on Windows version and the capture path; it should not be assumed to cover every recorder, remote-control tool, camera, or virtualized environment.

### macOS capture approaches

The article contrasts:

- `CGWindowListCreateImage`, a traditional window-list/compositing capture API.
- ScreenCaptureKit, Apple's newer filter-oriented capture framework, introduced in macOS 12.3.

It also discusses the `NSWindow` sharing-type concept. At a high level, macOS window metadata/policies can affect inclusion in certain capture paths, but applications can use different capture mechanisms.

### Practical lesson

Capture behavior must be tested across OS release, conferencing app/version, full-display versus selected-window sharing, capture framework, and multi-monitor configuration.

---

## 4. Electron window configuration

The article's Live Interview window uses a set of Electron `BrowserWindow` options to create a compact, frameless, transparent, floating panel.

| Property | Purpose described |
|---|---|
| `width`, `height` | Initial dimensions. |
| `alwaysOnTop` | Places the panel above ordinary windows. |
| `fullscreenable: false` | Prevents the panel itself entering fullscreen. |
| `focusable` | Controls whether it can receive focus. |
| `frame: false` | Removes the native frame/title bar. |
| `hasShadow: false` | Removes the native shadow, especially relevant on macOS. |
| `transparent: true` | Enables transparent rendering. |
| `backgroundColor: '#00000000'` | Fully transparent background color. |
| `skipTaskbar: true` | Omits the window from the taskbar where supported. |
| `titleBarStyle: 'hidden'` | Hides the standard title bar. |
| `type: 'panel'` | Uses panel-style behavior on macOS. |
| `movable: true` | Allows repositioning. |
| `paintWhenInitiallyHidden` | Controls renderer painting before the window is shown. |

The article also mentions platform-specific construction options, including a Windows frame setting.

**Important:** Transparency, framelessness, and always-on-top behavior are appearance/interaction choices. They do not by themselves mean a window is excluded from screen capture. These properties can be useful for a disclosed timer, teleprompter, note panel, accessibility utility, or picture-in-picture interface.

---

## 5. Declarative visibility configuration

A strong general design decision in the article is to treat window behavior as configuration rather than scattering native calls throughout the codebase.

The author's `WindowVisibilityConfig`-style type includes fields for opacity, mouse-event handling, taskbar visibility, always-on-top behavior/level, workspace visibility, fullscreen behavior, focusability, and content-protection state. A factory applies a selected configuration to the BrowserWindow.

### Why this helps

1. Window behavior is easier to review.
2. State transitions are more consistent.
3. Platform-specific defaults can be isolated.
4. Duplicated imperative calls are reduced.
5. State selection is easier to test.

The article notes preserving window bounds after applying a group of settings because native window changes can affect geometry.

For a transparent and disclosed utility, use clear states such as `visible-interactive`, `visible-read-only`, `minimized`, and `closed`. Each should have an explicit user-facing meaning and an obvious way to restore or close the window.

---

## 6. Mouse interaction and click-through windows

Electron supports ignoring mouse events for a window. The article describes switching between an interactive state and a pass-through state.

This general UX concept can be useful for a read-only status display, floating clock, or annotation layer. The article also mentions forwarding mouse events on macOS so the underlying application can receive them while the overlay can still detect pointer enter/leave behavior.

For a user-facing product, click-through mode should be clearly indicated and users should have a reliable way to return to interactive mode.

---

## 7. Focus behavior and keyboard interaction

The article distinguishes showing a native window from activating it. Non-activating presentation can be useful for notifications, passive status panels, and picture-in-picture interfaces.

The article also describes focus-monitoring avoidance in the context of interview assistance. This document does not provide an implementation recipe for evading an assessment platform's focus or proctoring controls.

### Shortcuts documented in the repository README

| Shortcut | Documented action |
|---|---|
| `⌘ + B` | Toggle window visibility. |
| `⌘ + H` | Capture a screenshot. |
| `⌘ + ↑ / ↓ / ← / →` | Move the window. |
| `⌘ + Return` | Generate a solution / invoke debugging flow depending on context. |
| `⌘ + G` | Reset context. |

The article mentions debouncing visibility toggles and delaying shortcut re-registration after changing shortcut sets. General lessons: avoid conflicting rapid state transitions, check whether shortcut registration succeeds, make shortcuts discoverable, and avoid conflicts with OS/application shortcuts.

---

## 8. Window positioning and dynamic sizing

The article describes keyboard-driven positioning and a dynamic sizing model.

### Positioning concepts

- Maintain the current x/y position.
- Move in predictable increments.
- Apply bounds so the window cannot become irretrievably lost.
- Re-center if a display change leaves it outside the usable work area.
- Re-evaluate display geometry when monitors are connected or disconnected.

### Dynamic sizing concepts

The renderer measures its content and sends desired dimensions to the main process through IPC. The main process then applies a maximum width based on the work area, preserves the current position where possible, checks whether the resized window would be off-screen, recenters if needed, applies new bounds, and updates stored geometry.

The article gives an example width cap of 40% of the primary display work-area width plus a small padding allowance. These are author-selected UX values, not platform requirements.

### General implementation lessons

- Centralize geometry calculations in the main process.
- Account for multiple displays and display disconnection.
- Use the display work area rather than assuming the full screen is available.
- Clamp dimensions to reasonable limits.
- Test different DPI/scaling settings.
- Validate IPC dimensions to prevent invalid or extreme sizes.

---

## 9. macOS and Zoom compatibility

The article identifies macOS Zoom as a particularly difficult compatibility case. The author's explanation is that some capture paths respect window-level capture semantics while other configurations may capture display output differently.

The article describes a Zoom setting called **“Use advanced capture with window filtering”** and recommends selected-window sharing rather than sharing the entire desktop. This is the author's reported, version-sensitive workaround—not a guarantee of exclusion. Zoom settings and capture implementations can change.

### General lesson

For a legitimate private-content utility:

- Tell users when a window contains private information.
- Provide an obvious “pause private content” or close control.
- Test supported capture workflows.
- Document limitations.
- Never treat capture-exclusion APIs as a security boundary for secrets.

---

## 10. Process identity and packaging

The article discusses build-time application naming through a `PRODUCT_NAME` variable. Changing product name can affect the visible app identity and generated artifact names.

For a legitimate product, application identity should remain accurate and recognizable: use a truthful product name, sign/notarize macOS builds as appropriate, use a consistent Windows publisher identity, and keep bundle identifiers stable. Do not disguise an application as a system utility or another product.

---

## 11. Testing strategy

The author emphasizes repeated cross-platform testing.

| Dimension | Examples in article |
|---|---|
| OS | Windows 10/11; macOS 12–15 |
| Capture application | Zoom, Teams, Google Meet, Chime |
| Capture target | Full display vs selected window |
| App type | Native desktop app vs browser-based app |
| Version | Multiple versions of the same conferencing app |
| Process identity | Activity Monitor / Task Manager |
| Build | Windows and macOS CI builds |

The article describes automated build checks and manual capture testing with a second device. The broader lesson is that capture behavior is an integration property involving the OS and sharing application, not merely a unit-testable property of the Electron app.

For a legitimate application, test that the panel is visible and behaves as documented, shortcuts are registered/released correctly, it can always be restored and closed, permissions are handled gracefully, display changes do not strand it off-screen, and private content is not unexpectedly exposed.

---

## 12. Main lessons from the article

1. **Electron abstractions are useful but do not erase OS differences.** Understanding native concepts helps diagnose behavior.
2. **Windows and macOS differ.** Their window managers and capture paths are not interchangeable.
3. **Declarative window configuration pays off.** Centralized state avoids inconsistent behavior.
4. **Focus behavior is distinct from rendering.** A window can look correct while interacting unexpectedly with the desktop.
5. **Testing is ongoing.** OS and conferencing-app updates can change behavior.

---

## 13. What is useful for InterviewCopilot

Our current InterviewCopilot project already has a React/Vite frontend and a Python/FastAPI backend, with Amazon Transcribe and Amazon Bedrock planned for audio and AI.

We can adopt the general desktop architecture without adopting the article's concealment or assessment-evasion objectives.

### Suggested project structure

```text
InterviewCopilot/
├── desktop/
│   └── electron/
│       ├── main.ts
│       ├── preload.ts
│       ├── ipc/
│       └── window/
├── frontend/
│   └── React application
├── backend/
│   └── Python FastAPI application
└── infrastructure/
    └── terraform/
```

### Responsibilities

| Component | Responsibility |
|---|---|
| Electron main process | App lifecycle, native window, shortcuts, permissions |
| Preload | Narrow, validated IPC bridge |
| React renderer | InterviewCopilot UI |
| FastAPI | WebSocket sessions and application API |
| Amazon Transcribe | Streaming speech recognition |
| Amazon Bedrock | Response generation |
| S3 | Optional user-authorized document storage |
| ECS Fargate | AWS backend hosting |

### Suggested implementation sequence

1. Keep the current React dashboard and FastAPI service working.
2. Add an Electron shell around the existing frontend.
3. Add a secure preload bridge with a small typed API.
4. Implement visible, user-controlled window modes (normal, compact, minimized).
5. Add keyboard shortcuts for documented product actions.
6. Add explicit microphone and system-audio permission flows.
7. Connect the desktop audio client to the existing FastAPI WebSocket.
8. Verify the Transcribe and Bedrock flow.
9. Add packaging and code signing for macOS and Windows.
10. Add a screen-sharing privacy indicator and pause/close control.

### Electron security checklist

- Keep `nodeIntegration` disabled.
- Keep `contextIsolation` enabled.
- Use a preload script and expose only required functions.
- Validate every IPC message and argument.
- Do not allow arbitrary renderer-supplied filesystem paths or shell commands.
- Keep AWS credentials out of the desktop renderer.
- Use short-lived credentials or authenticated backend requests.
- Request microphone and screen-recording permissions only when needed.
- Make capture and AI-processing status visible.

---

## 14. Repository setup information

The repository README lists Node.js 24.15.0 or higher and pnpm 11.0.9 or higher.

Basic setup:

```bash
git clone https://github.com/GetEzzi/ezzi-app.git
cd ezzi
pnpm install
```

For development with mocked responses, the README shows:

```ini
IS_MOCK=true
```

For self-hosted mode:

```ini
VITE_SELF_HOSTED_MODE=true
VITE_API_BASE_URL=http://localhost:3000
```

Run development mode:

```bash
pnpm run dev
```

Build:

```bash
pnpm run build
```

Test:

```bash
pnpm test
```

These commands are transcribed from the repository README. Check the current repository before running them because prerequisites and scripts may change.

---

## 15. Sources

1. Dmitry Khorev, **How I Made a Desktop App Invisible to Screen Sharing (Electron + OS-Level Tricks)**, Level Up Coding, March 13, 2026:  
   https://levelup.gitconnected.com/how-i-made-a-desktop-app-invisible-to-screen-sharing-electron-os-level-tricks-5734513c1e67

2. **GetEzzi/ezzi-app** GitHub repository and README:  
   https://github.com/GetEzzi/ezzi-app

3. **Ezzi self-hosted guide**:  
   https://github.com/GetEzzi/ezzi-app/blob/main/SELF_HOSTED.md

4. **Electron BrowserWindow documentation**:  
   https://www.electronjs.org/docs/latest/api/browser-window

5. **Electron context isolation documentation**:  
   https://www.electronjs.org/docs/latest/tutorial/context-isolation

6. **Apple ScreenCaptureKit documentation**:  
   https://developer.apple.com/documentation/screencapturekit

7. **Microsoft SetWindowDisplayAffinity documentation**:  
   https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity

---

## Closing note

Ezzi's most reusable engineering ideas are its separation of the Electron main process from the React renderer, centralized window configuration, IPC boundary, keyboard-accessible controls, dynamic window geometry, and cross-platform test discipline.

For InterviewCopilot, the sound path is to reuse those desktop-application patterns while keeping the product transparent, consent-based, and secure. Screen-capture exclusion and focus-monitoring evasion should not be used to misrepresent the presence of assistance in an interview or other monitored assessment.
