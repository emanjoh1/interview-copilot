#!/bin/bash
# InterviewCopilot Launcher
# Double-click this to start the backend and open the app.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$SCRIPT_DIR"

# ── 1. Find python in the venv ────────────────────────────────────────────────
PYTHON="$REPO/backend/.venv/bin/python"
if [ ! -f "$PYTHON" ]; then
  osascript -e 'display alert "InterviewCopilot" message "Python venv not found.\nRun:\n  cd backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"'
  exit 1
fi

# ── 2. Check .env exists ──────────────────────────────────────────────────────
if [ ! -f "$REPO/backend/.env" ]; then
  osascript -e 'display alert "InterviewCopilot" message "backend/.env not found.\nCopy backend/.env.example to backend/.env and set BEDROCK_MODEL_ID."'
  exit 1
fi

# ── 3. Start FastAPI backend in background ────────────────────────────────────
LOG="/tmp/interview-copilot-backend.log"
cd "$REPO/backend"
"$PYTHON" -m uvicorn app.main:app --port 8000 > "$LOG" 2>&1 &
BACKEND_PID=$!
echo "Backend PID: $BACKEND_PID"

# ── 4. Wait for backend to be ready (up to 10 s) ─────────────────────────────
for i in $(seq 1 20); do
  if curl -s http://localhost:8000/health > /dev/null 2>&1; then
    echo "Backend ready."
    break
  fi
  sleep 0.5
done

# ── 5. Open the Desktop app ───────────────────────────────────────────────────
open "$HOME/Desktop/InterviewCopilot.app"

# ── 6. Wait for the app to quit, then stop the backend ───────────────────────
# Poll until the app process is gone
while pgrep -x "InterviewCopilot" > /dev/null 2>&1; do
  sleep 2
done

echo "App closed. Stopping backend (PID $BACKEND_PID)…"
kill $BACKEND_PID 2>/dev/null
