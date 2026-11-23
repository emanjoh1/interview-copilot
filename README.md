# InterviewCopilot

A real-time AI interview assistant that runs as an **invisible desktop overlay**. It listens to your interview conversation, transcribes it live, and generates contextual AI answers — all while remaining undetectable to screen sharing.

![Session screen](https://placeholder/session.png)

## Features

- **Live transcription** via Amazon Transcribe Streaming
- **AI-generated answers** via Amazon Bedrock (Claude / Nova)
- **Invisible overlay** — excluded from screen capture on macOS and Windows
- **Coding problem solver** — screenshot any coding challenge and get a full solution with one keypress
- **Resume & JD context** — answers tailored to the specific role
- **Session transcripts** — every session saved locally for review
- **My Thoughts** scratchpad — jot down what you want to say before speaking
- **Text style controls** — change font colour, size, and weight on the fly

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 45 |
| Frontend | React 19 + TypeScript + Vite |
| Backend | FastAPI + Python 3.12+ |
| Transcription | Amazon Transcribe Streaming |
| AI / LLM | Amazon Bedrock Converse API |
| Audio | Web Audio API (mic + BlackHole virtual device) |

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 22+ | `node --version` |
| Python | 3.12+ | `python3 --version` |
| npm | 9+ | comes with Node |
| AWS CLI | v2 | configured with SSO or credentials |
| AWS account | — | Transcribe Streaming + Bedrock access |

### AWS permissions required

Your AWS identity needs:
- `transcribe:StartStreamTranscription`
- `bedrock:InvokeModel` for your chosen model (e.g. `us.amazon.nova-lite-v1:0`)

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/interview-copilot.git
cd interview-copilot
```

### 2. Backend setup

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create your environment file:

```bash
cp .env.example .env
```

Edit `backend/.env`:

```ini
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0
# Leave blank to use AWS credential chain (SSO, instance role, etc)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

### 3. Frontend setup

```bash
cd frontend
npm install
```

### 4. Configure AWS credentials

**Option A — AWS SSO (recommended):**
```bash
aws configure sso
aws sso login --profile YOUR_PROFILE
```

Then set `AWS_PROFILE=YOUR_PROFILE` in `backend/.env`.

**Option B — Access keys:**
Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `backend/.env`.

---

## Running locally (development)

You need **three terminals**:

**Terminal 1 — Backend:**
```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
```

**Terminal 3 — Electron:**
```bash
npm run dev
```

The app opens automatically and loads from `http://localhost:5173`.

---

## Building the Desktop App

Builds a self-contained `.app` (macOS) that bundles the backend and starts it automatically on launch.

### macOS

```bash
# 1. Create entitlements file (required for screen recording)
cat > /tmp/entitlements.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.device.screen-capture</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
</dict>
</plist>
EOF

# 2. Build
npm run package
```

The app is output to `dist/mac-arm64/InterviewCopilot.app`. Copy it to your Applications folder or Desktop.

> **Note:** The package script already applies the entitlements. The backend `.venv` is bundled inside the `.app` — no separate Python installation needed to run the built app.

### First launch (macOS)

1. Right-click the app → **Open** (bypasses Gatekeeper for unsigned apps)
2. When prompted, allow **Microphone** access
3. When prompted, allow **Screen Recording** access (needed for `Cmd+H` screenshot solver)

---

## Usage

### Setup screen

1. Paste your **resume** and **job description** (or upload PDF/DOCX)
2. Select audio sources:
   - **Microphone** — your voice
   - **Call audio** — interviewer's voice via [BlackHole](https://github.com/ExistentialAudio/BlackHole) virtual device
3. Click **Start session**

### Session screen

| Element | Description |
|---|---|
| **Q strip** | Shows detected question — click to edit if transcription was wrong |
| **Answer area** | AI-generated answer, auto-appears after each question |
| **My Thoughts** | Your own scratchpad — jot notes before speaking |
| **Answer** button | Manually trigger an AI answer for the current question |
| **Solve** button | Capture screen and solve a coding problem |
| **Language** picker | Choose the coding language for solutions |
| **Aa** button | Change text colour, size, and weight |
| **📋** button | Copy the answer to clipboard |

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+B` | Toggle overlay visibility (hide / show) |
| `Cmd+H` | Capture screen and solve coding problem |
| `Cmd+↑↓←→` | Move the overlay window |
| `Cmd+Q` | Quit |

### Screen sharing invisibility

The overlay is excluded from screen capture using:
- `setContentProtection(true)` — macOS `NSWindowSharingNone` / Windows `WDA_EXCLUDEFROMCAPTURE`
- `setHiddenInMissionControl(true)` — hidden from macOS Mission Control / Exposé
- `alwaysOnTop: 'screen-saver'` — floats above all other windows

**For Zoom:** Use **Share Window** (not Share Screen), and enable:
> Zoom Settings → Share Screen → **Use advanced capture with window filtering**

---

## Project Structure

```
interview-copilot/
├── backend/                  # FastAPI Python server
│   ├── app/
│   │   ├── main.py           # API routes + WebSocket
│   │   ├── config.py         # Settings (pydantic-settings)
│   │   ├── interview.py      # Bedrock LLM logic
│   │   └── transcribe.py     # Amazon Transcribe Streaming
│   ├── requirements.txt
│   └── .env.example
├── frontend/                 # React + TypeScript + Vite
│   └── src/
│       ├── App.tsx           # Full UI
│       ├── styles.css
│       └── types/electron.d.ts
├── electron/                 # Electron main process
│   ├── main.js               # Window management, IPC, backend spawn
│   └── preload.js            # Secure IPC bridge
└── package.json              # Electron app config + build
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AWS_REGION` | Yes | `us-east-1` | AWS region for Transcribe + Bedrock |
| `BEDROCK_MODEL_ID` | Yes | — | Model ID e.g. `us.amazon.nova-lite-v1:0` |
| `AWS_PROFILE` | No | `default` | AWS CLI profile name |
| `AWS_ACCESS_KEY_ID` | No | — | Use instead of SSO |
| `AWS_SECRET_ACCESS_KEY` | No | — | Use instead of SSO |
| `LANGUAGE_CODE` | No | `en-US` | Transcribe language |
| `MODEL_MAX_TOKENS` | No | `1200` | Max tokens for interview answers |
| `FRONTEND_ORIGIN` | No | `http://localhost:5173` | CORS origin for dev |

---

## Troubleshooting

**"Connection closed" when starting a session**
- The backend process died. Close the app with the 🔴 button, reopen it.
- Check: `cat /var/folders/*/*/T/interview-copilot-backend.log | tail -20`

**No transcription appearing**
- Check microphone permission: System Settings → Privacy → Microphone
- Verify AWS credentials: `aws sts get-caller-identity --profile YOUR_PROFILE`
- Check SSO session: `aws sso login --profile YOUR_PROFILE`

**Solve button not working**
- Grant Screen Recording: System Settings → Privacy → Screen Recording → enable InterviewCopilot
- Restart the app after granting permission

**App still visible in Zoom screen share**
- Use **Share Window** (not Share Screen) in Zoom
- Enable: Zoom → Settings → Share Screen → Use advanced capture with window filtering

---

## Acknowledgements

- Architecture inspired by [Ezzi](https://github.com/GetEzzi/ezzi-app) — Electron overlay patterns
- Screen capture invisibility techniques from Dmitry Khorev's article on OS-level window management
