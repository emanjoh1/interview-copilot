# InterviewCopilot: project context

This file summarizes what the app does, how it is built, how to run and package it, and the decisions and fixes made along the way. Read it before changing the project.

## What the app does

InterviewCopilot is a macOS desktop app (Electron) with a Python backend that uses AWS:

1. **Live transcription.** It captures your microphone and/or call audio, streams it to Amazon Transcribe, and shows a live transcript.
2. **Suggested answers.** About 1.5 seconds after a finalized transcript segment, or when you click a segment, it sends the text to Amazon Bedrock. Bedrock returns a suggested answer plus technical talking points. The last 5 question/answer turns are sent along as context.
3. **Resume and job-description context.** You can paste or upload (PDF, DOCX, TXT) a resume and a job description. These are added to the Bedrock prompt so answers are tailored to them.
4. **Solve from screen.** It captures one frame of a screen or window you pick, sends it to Bedrock as an image, and returns: the problem restated, the approach, the code, Big-O complexity, and edge cases.

The app runs as a normal, visible window. It was deliberately **not** built to hide itself from screen sharing.

## Architecture

```
InterviewCopilot.app (Electron)
 ├─ Main process: electron/main.js
 │   ├─ Serves the built React app from frontend/dist at app://interview-copilot
 │   ├─ Starts the FastAPI backend (backend/.venv) if port 8000 isn't already answering
 │   ├─ Grants mic, screen-capture and clipboard permissions to its own pages only
 │   └─ Uses the macOS 15+ system picker for screen capture
 └─ Renderer: React app (frontend/src/App.tsx)
      ├─ Audio: getUserMedia (mic + BlackHole) → resample to 16 kHz PCM16 → WebSocket
      ├─ Answers: POST /api/answer
      ├─ Context files: POST /api/context/file
      └─ Screen solve: getDisplayMedia → one JPEG frame → POST /api/solve

FastAPI backend (backend/app, http://127.0.0.1:8000)
 ├─ GET  /health
 ├─ WS   /ws/transcribe     → Amazon Transcribe Streaming (en-US, 16 kHz PCM)
 ├─ POST /api/answer        → Bedrock Converse (text)
 ├─ POST /api/solve         → Bedrock Converse (image + text)
 └─ POST /api/context/file  → text extraction from PDF / DOCX / TXT
```

## Project layout

| Path | Purpose |
|---|---|
| `electron/main.js` | Electron main process: window, `app://` protocol, backend startup, permissions, screen-capture handler. |
| `electron/index.html`, `app.js`, `capture.js`, `preload.js` | Old, broken prototype files. **Unused**; safe to delete. |
| `frontend/` | React + Vite + TypeScript UI. `src/App.tsx` holds all logic; `src/styles.css` holds all styling. |
| `backend/app/main.py` | FastAPI routes, CORS, upload validation, transcription WebSocket. |
| `backend/app/interview.py` | Bedrock prompts and calls: `generate_answer` (interview answers) and `solve_coding_problem` (screenshots). |
| `backend/app/transcribe.py` | Amazon Transcribe Streaming client. |
| `backend/app/config.py` | Settings, read from `backend/.env`. |
| `backend/.env` | Local config and AWS credentials. **Never commit it.** |
| `package.json` (root) | Electron scripts and electron-builder config. |
| `dist/mac-arm64/InterviewCopilot.app` | Packaged app (build output). |
| `~/Desktop/InterviewCopilot.app` | The installed copy you open. |
| `Dockerfile`, `docker-compose.yml` | Container setup for the backend and web UI (browser use, not the desktop app). |
| `infrastructure/terraform/` | Empty placeholder. |

## Configuration (`backend/.env`)

| Key | Current / default | Notes |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Region for Transcribe and Bedrock. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | set | The desktop app loads `.env` into the backend's environment, so boto3 sees these when the app is opened from Finder. |
| `BEDROCK_MODEL_ID` | `us.amazon.nova-lite-v1:0` | Must support image input for Solve from screen. A stronger model gives better coding answers. |
| `MODEL_MAX_TOKENS` | `700` | Limit for interview answers. |
| `CODING_MAX_TOKENS` | `3000` (default in `config.py`) | Limit for coding solutions. |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS origin for the browser/Vite UI. |
| `DESKTOP_ORIGIN` | `app://interview-copilot` (default) | CORS origin for the desktop app. |
| `LANGUAGE_CODE` | `en-US` | |

Required AWS permissions: `transcribe:StartStreamTranscription` and `bedrock:InvokeModel` for the configured model.

## Running and building

All commands run from the project root (`interview-copilot/`) unless noted.

| Goal | Command |
|---|---|
| Open the desktop app | Double-click `~/Desktop/InterviewCopilot.app`. It starts the backend itself. |
| Rebuild the desktop app | `npm run package`, then replace the Desktop copy with `dist/mac-arm64/InterviewCopilot.app`. |
| Run Electron without packaging | `npm start` (builds the frontend first). |
| Electron with hot reload | Run `npm run dev` in `frontend/`, then `npm run dev` in the root. |
| Backend manually | In `backend/`: `source .venv/bin/activate`, then `uvicorn app.main:app --reload --port 8000`. |
| Browser UI only | In `frontend/`: `npm run dev`, then open http://localhost:5173. |

`npm run package` builds the frontend, packages with electron-builder (`--mac --dir`), records the backend folder's absolute path in the bundled `package.json` (`backendDir`), and ad-hoc signs the app with `codesign --sign -`.

## Capturing call audio with BlackHole

Electron can only capture system audio on Windows. On macOS, call audio is routed through the BlackHole virtual audio device:

1. Install BlackHole: `brew install --cask blackhole-2ch`, then `sudo killall coreaudiod` (or restart the Mac) so macOS loads it.
2. In **Audio MIDI Setup**, create a **Multi-Output Device** with BlackHole 2ch and your speakers or headphones ticked. Make the speakers the primary device and tick Drift Correction on BlackHole.
3. In Zoom or Teams, set **Speaker** to Multi-Output Device. Keep **Microphone** on your real mic.
4. In the app, **Call audio** auto-selects BlackHole 2ch. **Microphone** has its own device picker. Use headphones, or the mic picks up the call and lines are transcribed twice.

While Multi-Output Device is the output, the Mac's volume keys don't work.

## Issues fixed during the build

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'fastapi'` | `uvicorn` ran under the global Python, not `backend/.venv`. | Activate the venv first. The desktop app uses the venv's Python directly. |
| http://localhost:5173 returned 404 | A second Vite server, started from the project root (which has no `index.html`), held `127.0.0.1:5173`. | Stopped it. Removed the root `"dev": "vite"` script. |
| Original Electron code didn't work | It called APIs that don't exist (`webContents.writeString`, `win.load`) and never captured audio. | Rewrote `electron/main.js` to wrap the React app. |
| "Permission denied" on Start listening | Node's `URL` parser returns origin `"null"` for `app://`, so the app's permission check refused its own pages. | Compare URL prefixes instead of origins. |
| macOS refusing permissions without prompting | electron-builder left the unsigned bundle with a broken signature. | Ad-hoc sign the bundle after packaging. |
| Start listening failed when shared audio had no track | The frontend always requested screen audio and fed an empty stream into the audio graph. | Capture only selected sources, from chosen input devices. |
| Copy buttons did nothing | The permission handler also refused `clipboard-sanitized-write`. | Allow that permission for the app's own pages. |

## Known limitations

- The packaged app runs the backend from `~/Downloads/interview-copilot/backend` (absolute path recorded at build time). Moving or deleting that folder breaks the app until you rebuild.
- The app is ad-hoc signed, not notarized. On first launch, macOS may require right-click → **Open**.
- System audio on macOS requires BlackHole (see above).
- Solve from screen reads one frame. Long problems must fit in view; capture a single window for legibility.
- Nova Lite is fast but weaker on hard problems.
- Transcription is English only. There's no speaker separation, no saved history, and no authentication. Audio is streamed, not stored.
- Transcribe and Bedrock calls cost money. Stop sessions when not in use.

## Responsible use

Recording other people on a call usually requires their consent, and in some places it's the law. Tell the people on the call when the app is transcribing them. If you share your whole screen, the app window and its answers are visible to others.
