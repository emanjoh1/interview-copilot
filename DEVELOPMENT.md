# Local Development Guide

This guide is for developing and testing changes to InterviewCopilot without affecting the stable packaged app on your Desktop.

---

## The Two-Track Workflow

| Track | How to run | When to use |
|---|---|---|
| **Stable** | Double-click `InterviewCopilot.app` on Desktop | Real interviews, daily use |
| **Dev** | `npm run dev` (3 terminals below) | Testing changes |

The packaged `.app` is completely self-contained — it never changes unless you explicitly run `npm run package`. You can develop and break things in the dev track without touching the stable version.

---

## Prerequisites

Make sure these are installed and working:

```bash
node --version    # 22+
python3 --version # 3.12+
aws sso login --profile Babs   # refresh SSO if needed
```

---

## Running in Dev Mode

You need **three terminals** open at the same time.

### Terminal 1 — Backend

```bash
cd /Users/babs/Downloads/interview-copilot/backend
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

You should see:
```
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000
```

### Terminal 2 — Frontend (Vite)

```bash
cd /Users/babs/Downloads/interview-copilot/frontend
npm run dev
```

You should see:
```
  VITE ready in 300ms
  ➜  Local:   http://localhost:5173/
```

### Terminal 3 — Electron

```bash
cd /Users/babs/Downloads/interview-copilot
npm run dev
```

This opens the Electron window loading from `http://localhost:5173`. Hot-reload is active — frontend changes appear immediately without restarting Electron.

> **Tip:** Use `npm run dev:debug` instead to also open DevTools in a detached window.

---

## Making and Testing Changes

### Frontend changes (`frontend/src/`)
Just save the file — Vite hot-reloads instantly. No restart needed.

### Backend changes (`backend/app/`)
Uvicorn runs with `--reload` so it restarts automatically on save.

### Electron/main process changes (`electron/main.js`, `electron/preload.js`)
You need to restart Terminal 3:
```bash
# Ctrl+C in Terminal 3, then:
npm run dev
```

---

## Deploying to the Stable Desktop App

When you're happy with your changes, build and copy to Desktop:

```bash
cd /Users/babs/Downloads/interview-copilot

# 1. Build frontend + package Electron app
npm run package

# 2. Replace stable app on Desktop
rm -rf ~/Desktop/InterviewCopilot.app
cp -R dist/mac-arm64/InterviewCopilot.app ~/Desktop/InterviewCopilot.app

echo "Done — stable app updated"
```

> The stable app bundles the backend `.venv` and `.env` inside the `.asar` automatically.

---

## Git Workflow

```bash
# Save your work
git add -A
git commit -m "feat: describe what you changed"
git push

# Tag a stable release
git tag v0.3.0
git push origin v0.3.0
```

---

## Useful Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev mode — Electron loads from Vite |
| `npm run dev:debug` | Dev mode + DevTools open |
| `npm run build:frontend` | Build frontend only |
| `npm run package` | Full build → `dist/mac-arm64/InterviewCopilot.app` |

---

## Checking the Backend Log (Packaged App)

If the stable packaged app has issues, check its log:

```bash
cat /var/folders/*/T/interview-copilot-backend.log | tail -30
```

---

## Environment Variables

Copy and edit `backend/.env` before running in dev mode:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env — set BEDROCK_MODEL_ID and AWS_PROFILE
```

Key variables:

| Variable | Required | Example |
|---|---|---|
| `BEDROCK_MODEL_ID` | Yes | `us.amazon.nova-lite-v1:0` |
| `AWS_REGION` | Yes | `us-east-1` |
| `AWS_PROFILE` | No | `Babs` |
