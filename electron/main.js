'use strict';

const { app, BrowserWindow, desktopCapturer, protocol, screen, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const http = require('http');

// ─── Backend process management ───────────────────────────────────────────────
let backendProcess = null;

function getBackendPaths() {
  // Works both in dev (repo root) and packaged (app.asar/../..)
  const isPackaged = app.isPackaged;
  const repoRoot = isPackaged
    ? path.join(process.resourcesPath, 'backend')   // extraResources puts it here
    : path.join(__dirname, '..', 'backend');

  const venvPython = path.join(repoRoot, '.venv', 'bin', 'python');
  const appDir     = path.join(repoRoot, 'app');
  const envFile    = path.join(repoRoot, '.env');
  return { repoRoot, venvPython, appDir, envFile };
}

function startBackend() {
  // Write immediate debug marker — if this file doesn't appear, startBackend was never called
  try {
    fs.writeFileSync('/tmp/ic-start-debug.txt',
      `startBackend called at ${new Date().toISOString()}\nisPackaged=${app.isPackaged}\nresourcesPath=${process.resourcesPath}\n`
    );
  } catch(e) {}

  const { repoRoot, venvPython, envFile } = getBackendPaths();

  try {
    fs.appendFileSync('/tmp/ic-start-debug.txt',
      `repoRoot=${repoRoot}\nvenvPython=${venvPython}\nvenvExists=${fs.existsSync(venvPython)}\nenvExists=${fs.existsSync(envFile)}\n`
    );
  } catch(e) {}

  if (!fs.existsSync(venvPython)) {
    console.error('[backend] venv not found at', venvPython);
    return;
  }

  // Kill any stale process already on port 8000 before spawning
  try {
    const { execSync } = require('child_process');
    const pid = execSync("lsof -ti:8000 2>/dev/null || true").toString().trim();
    if (pid) {
      execSync(`kill -9 ${pid} 2>/dev/null || true`);
      console.log('[backend] killed stale process on port 8000, pid:', pid);
    }
  } catch (e) { /* ignore */ }

  // Load .env file into an object so we can pass it to the child env
  const envVars = {};
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (val) envVars[key] = val;
      }
    });
  }

  const childEnv = {
    ...process.env,
    ...envVars,
    PATH: [path.join(repoRoot, '.venv', 'bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH||''].filter(Boolean).join(':'),
    HOME: os.homedir(),
    AWS_PROFILE: envVars.AWS_PROFILE || process.env.AWS_PROFILE || 'Babs',
    PYTHONPATH: '',
    PYTHONHOME: '',
  };

  const logFile = path.join(os.tmpdir(), 'interview-copilot-backend.log');
  const alog = (m) => { try { fs.appendFileSync(logFile, m+'\n'); } catch(e) {} };
  alog('\n--- Backend start ' + new Date().toISOString() + ' ---');
  alog('python: ' + venvPython + ' exists:' + fs.existsSync(venvPython));
  alog('cwd: ' + repoRoot);
  alog('profile: ' + childEnv.AWS_PROFILE);
  alog('PATH start: ' + childEnv.PATH.slice(0,120));

  // spawnSync to test python works and capture any immediate crash
  const { spawnSync } = require('child_process');
  const test = spawnSync(venvPython, ['--version'], { env: childEnv, cwd: repoRoot, timeout: 5000 });
  alog('python --version: ' + (test.stdout||'') + (test.stderr||'') + ' code:' + test.status + (test.error?' err:'+test.error.message:''));
  if (test.error || test.status !== 0) {
    alog('Python test failed — aborting backend start');
    return;
  }

  backendProcess = spawn(venvPython,
    ['-m', 'uvicorn', 'app.main:app', '--port', '8000', '--host', '127.0.0.1'],
    { cwd: repoRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  backendProcess.stdout.on('data', d => { const s=d.toString().trim(); console.log('[B]',s); alog(s); });
  backendProcess.stderr.on('data', d => { const s=d.toString().trim(); console.error('[B]',s); alog('ERR:'+s); });
  backendProcess.on('error', e => { alog('[backend] spawn error: '+e.message); backendProcess=null; });
  backendProcess.on('exit', (c, s) => {
    alog('[backend] exit code='+c+' sig='+s);
    backendProcess = null;
    // Auto-restart backend if it crashed unexpectedly (not from our SIGTERM)
    if (s !== 'SIGTERM' && s !== 'SIGKILL' && mainWindow && !mainWindow.isDestroyed()) {
      alog('[backend] unexpected exit — restarting in 2s');
      setTimeout(() => {
        if (!backendProcess) startBackend();
      }, 2000);
    }
  });
}

function stopBackend() {
  if (backendProcess) {
    console.log('[backend] stopping…');
    backendProcess.kill('SIGTERM');
    backendProcess = null;
  }
}

// Wait until http://127.0.0.1:8000/health responds, then call cb()
function waitForBackend(cb, retries = 40, delayMs = 500) {
  http.get('http://127.0.0.1:8000/health', (res) => {
    if (res.statusCode === 200) { cb(); }
    else if (retries > 0) { setTimeout(() => waitForBackend(cb, retries - 1, delayMs), delayMs); }
    else { console.error('[backend] never became healthy'); cb(); } // open UI anyway
  }).on('error', () => {
    if (retries > 0) { setTimeout(() => waitForBackend(cb, retries - 1, delayMs), delayMs); }
    else { console.error('[backend] health check timed out'); cb(); }
  });
}


let mainWindow = null;
let windowVisible = true;
let storedBounds = null;
let overlayInterval = null;   // keeps the window above all other apps continuously

// The correct always-on-top level for staying above full-screen apps on macOS.
// Counterintuitively 'screen-saver' does NOT work for full-screen spaces —
// full-screen apps run in a separate Space and screen-saver level windows
// do not follow into those Spaces unless setVisibleOnAllWorkspaces is set
// at window CREATION time AND re-asserted after each Space transition.
// The working combination is:
//   - setAlwaysOnTop(true, 'screen-saver', 1)  — stays above normal windows
//   - setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })  — joins all Spaces
//   - Called together on a tight interval (every 300ms) so it re-joins any
//     new Space that gets created when an app enters full-screen mode.
function startOverlayInterval() {
  if (overlayInterval) return;
  overlayInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !windowVisible) return;
    // Set both together — order matters: workspaces first, then level
    if (process.platform === 'darwin') {
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  }, 300);
}

function stopOverlayInterval() {
  if (overlayInterval) { clearInterval(overlayInterval); overlayInterval = null; }
}

// Declarative visibility configs — matches Ezzi LiveInterviewConfig exactly.
// contentProtection:true in EVERY state is the key to Zoom invisibility.
const VISIBILITY_CONFIGS = {
  'visible-interactive': {
    opacity: 1, ignoreMouseEvents: false, skipTaskbar: true,
    alwaysOnTop: true, alwaysOnTopLevel: 'screen-saver',
    visibleOnAllWorkspaces: true, visibleOnFullScreen: true,
    focusable: true, contentProtection: true,
  },
  'visible-passthrough': {
    opacity: 1, ignoreMouseEvents: true, skipTaskbar: true,
    alwaysOnTop: true, alwaysOnTopLevel: 'screen-saver',
    visibleOnAllWorkspaces: true, visibleOnFullScreen: true,
    focusable: false, contentProtection: true,
  },
  'hidden': {
    // Ezzi keeps alwaysOnTop + contentProtection ON even when hidden
    opacity: 0, ignoreMouseEvents: true, skipTaskbar: true,
    alwaysOnTop: true, alwaysOnTopLevel: 'screen-saver',
    visibleOnAllWorkspaces: true, visibleOnFullScreen: true,
    focusable: true, contentProtection: true,
  },
};

function applyVisibilityConfig(win, configName) {
  const cfg = VISIBILITY_CONFIGS[configName];
  if (!cfg || !win || win.isDestroyed()) return;

  const bounds = win.getBounds(); // snapshot before any native call

  // forward:true lets macOS pass clicks to windows underneath
  if (cfg.ignoreMouseEvents) {
    win.setIgnoreMouseEvents(true, { forward: true });
  } else {
    win.setIgnoreMouseEvents(false);
  }

  win.setFocusable(cfg.focusable);
  win.setSkipTaskbar(cfg.skipTaskbar);

  // Third arg = relative level 1 — Ezzi uses this; without it the window
  // can slip under Zoom's always-on-top chrome on macOS.
  win.setAlwaysOnTop(cfg.alwaysOnTop, cfg.alwaysOnTopLevel, 1);

  // Must be called on every visibility change — Zoom re-checks workspace
  // membership each time it starts capturing.
  win.setVisibleOnAllWorkspaces(cfg.visibleOnAllWorkspaces, {
    visibleOnFullScreen: cfg.visibleOnFullScreen,
  });

  // The primary screen-capture exclusion API.
  // macOS: NSWindowSharingNone — respected by CGWindowListCreateImage and SCK.
  // Windows: WDA_EXCLUDEFROMCAPTURE — enforced at DWM compositor level.
  win.setContentProtection(cfg.contentProtection);

  win.setOpacity(cfg.opacity);

  // macOS: hide from Mission Control / Exposé so it doesn't appear in app switcher
  // Keep traffic lights visible — they're native and handle close/minimize/fullscreen
  if (process.platform === 'darwin') {
    win.setHiddenInMissionControl(true);
    win.setHasShadow(true);
  }

  win.setBounds(bounds); // restore bounds after native calls
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const winWidth  = Math.min(1100, Math.round(workArea.width  * 0.82));
  const winHeight = Math.min(860,  Math.round(workArea.height * 0.88));
  const startX    = workArea.x + workArea.width  - winWidth  - 24;
  const startY    = workArea.y + 24;

  mainWindow = new BrowserWindow({
    x: startX, y: startY,
    width: winWidth, height: winHeight,

    // titleBarStyle:'hiddenInset' gives native macOS traffic lights (fully functional)
    // while still allowing our content to extend into the title bar area.
    // This is the standard macOS approach — no custom buttons needed in the UI.
    titleBarStyle:          'hiddenInset',
    trafficLightPosition:   { x: 14, y: 12 },
    transparent:            true,
    backgroundColor:        '#00000000',
    hasShadow:              true,
    alwaysOnTop:            true,
    show:                   false,
    fullscreenable:         false,
    focusable:              true,
    enableLargerThanScreen: true,
    skipTaskbar:            true,
    paintWhenInitiallyHidden: true,
    movable:                true,
    resizable:              true,

    webPreferences: {
      nodeIntegration:             false,
      contextIsolation:            true,
      sandbox:                     false,
      preload:                     path.join(__dirname, 'preload.js'),
      webSecurity:                 false,
      allowRunningInsecureContent: true,
    },
  });

  // Set workspace visibility and always-on-top level BEFORE showing the window.
  // This ensures the NSWindowCollectionBehavior is established before macOS
  // registers it in any Space — critical for full-screen Space support.
  if (process.platform === 'darwin') {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  mainWindow.setContentProtection(true);
  mainWindow.center(); // ensure it's on-screen, not off in a corner
  mainWindow.showInactive(); // show without stealing focus from current app

  // Apply full visibility config
  applyVisibilityConfig(mainWindow, 'visible-interactive');

  // Also request screen recording permission on first launch by calling getSources once
  // This shows the macOS permission prompt if not yet granted
  if (process.platform === 'darwin') {
    setTimeout(() => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
        .then(s => console.log('[copilot] Screen capture ready, sources:', s.length))
        .catch(e => console.log('[copilot] Screen capture prompt shown:', e.message));
    }, 2000);
  }

  const devUrl = process.env.ELECTRON_DEV_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
    // Allow opening DevTools in packaged app with Cmd+Option+I for debugging
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.meta && input.alt && input.key === 'i') {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    });
  }

  // Re-apply after page loads — Zoom may start sharing while page loads
  mainWindow.webContents.once('did-finish-load', () => {
    applyVisibilityConfig(mainWindow, 'visible-interactive');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (overlayInterval) { clearInterval(overlayInterval); overlayInterval = null; }
  });
  mainWindow.on('show', () => {
    windowVisible = true;
    applyVisibilityConfig(mainWindow, 'visible-interactive');
    startOverlayInterval();
  });
  mainWindow.on('hide', () => {
    windowVisible = false;
    stopOverlayInterval();
  });

  // Start the overlay enforcement interval once window is ready
  startOverlayInterval();

  attachIpcHandlers(mainWindow);
  registerGlobalShortcuts(mainWindow);
  watchDisplayChanges(mainWindow);
}

function attachIpcHandlers(win) {
  const channels = [
    'toggle-visibility','show-window','capture-screenshot',
    'get-window-bounds','set-window-position','resize-window','set-content-protection',
    'minimize-window','close-window',
    'save-session','list-sessions','load-session','open-sessions-folder',
  ];
  channels.forEach(ch => ipcMain.removeHandler(ch));

  // ── Session storage ───────────────────────────────────────────────────────
  const sessionsDir = path.join(app.getPath('userData'), 'sessions');
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

  ipcMain.handle('save-session', (event, sessionData) => {
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const filename = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.json`;
      const filepath = path.join(sessionsDir, filename);
      fs.writeFileSync(filepath, JSON.stringify({ ...sessionData, savedAt: now.toISOString() }, null, 2));
      console.log('[sessions] Saved:', filepath);
      return { success: true, filename };
    } catch (err) {
      console.error('[sessions] Save error:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-sessions', () => {
    try {
      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse() // newest first
        .slice(0, 50); // cap at 50
      return files.map(f => {
        try {
          const raw = fs.readFileSync(path.join(sessionsDir, f), 'utf8');
          const data = JSON.parse(raw);
          return { filename: f, savedAt: data.savedAt, turnCount: (data.turns || []).length, duration: data.duration || null, jobTitle: data.jobTitle || null };
        } catch { return { filename: f, savedAt: null, turnCount: 0 }; }
      });
    } catch (err) { return []; }
  });

  ipcMain.handle('load-session', (event, filename) => {
    try {
      const filepath = path.join(sessionsDir, path.basename(filename)); // sanitise
      const raw = fs.readFileSync(filepath, 'utf8');
      return { success: true, data: JSON.parse(raw) };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('open-sessions-folder', () => {
    const { shell } = require('electron');
    shell.openPath(sessionsDir);
  });

  ipcMain.handle('minimize-window', () => {
    if (!win || win.isDestroyed()) return;
    win.minimize();
  });

  ipcMain.handle('close-window', () => {
    stopBackend();         // kill backend before quitting
    stopOverlayInterval(); // stop the overlay interval
    globalShortcut.unregisterAll();
    app.exit(0);           // force-quit — works on macOS unlike app.quit()
  });

  ipcMain.handle('toggle-visibility', () => {
    if (!win || win.isDestroyed()) return { visible: false };
    if (windowVisible) {
      storedBounds = win.getBounds();
      applyVisibilityConfig(win, 'hidden');
      win.hide();
      windowVisible = false;
      stopOverlayInterval();
    } else {
      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      win.setAlwaysOnTop(true, 'screen-saver', 1);
      win.showInactive();
      if (storedBounds) win.setBounds(storedBounds);
      applyVisibilityConfig(win, 'visible-interactive');
      windowVisible = true;
      startOverlayInterval();
    }
    return { visible: windowVisible };
  });

  ipcMain.handle('show-window', () => {
    if (!win || win.isDestroyed()) return;
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.showInactive();
    if (storedBounds) win.setBounds(storedBounds);
    applyVisibilityConfig(win, 'visible-interactive');
    windowVisible = true;
    startOverlayInterval();
    return { visible: true };
  });

  ipcMain.handle('capture-screenshot', async () => {
    try {
      // On macOS 15 Sequoia, getMediaAccessStatus('screen') is unreliable with
      // ad-hoc signed apps — it reports 'denied' even when permission is granted.
      // Skip the status check and call getSources directly; it will work if the
      // user has granted Screen Recording in System Settings.
      let sources;
      try {
        sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1200 },
          fetchWindowIcons: false,
        });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[copilot] desktopCapturer.getSources failed:', msg);
        return { error: `getSources failed: "${msg}". Make sure Screen Recording is enabled for InterviewCopilot in System Settings → Privacy & Security → Screen Recording, then QUIT and REOPEN the app.` };
      }

      if (!sources || sources.length === 0) {
        return { error: 'getSources returned empty. Screen Recording permission may need to be re-granted — toggle it OFF then ON in System Settings → Privacy & Security → Screen Recording, then restart.' };
      }

      const pngBuffer = sources[0].thumbnail.toPNG();
      if (!pngBuffer || pngBuffer.length < 1000) {
        return { error: `Screenshot buffer too small (${pngBuffer?.length ?? 0} bytes). The screen may not be captured correctly.` };
      }

      console.log('[copilot] capture-screenshot OK:', pngBuffer.length, 'bytes');
      return { dataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}` };

    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error('[copilot] capture-screenshot error:', msg);
      return { error: `Capture error: ${msg}` };
    }
  });

  ipcMain.handle('get-window-bounds', () => (!win || win.isDestroyed()) ? null : win.getBounds());

  ipcMain.handle('set-window-position', (event, x, y) => {
    if (!win || win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    const { width, height } = win.getBounds();
    const cx = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width  - width));
    const cy = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));
    win.setPosition(cx, cy); return { x: cx, y: cy };
  });

  ipcMain.handle('resize-window', (event, reqW, reqH) => {
    if (!win || win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    const nw = Math.max(480, Math.min(reqW, Math.round(workArea.width  * 0.90)));
    const nh = Math.max(360, Math.min(reqH, Math.round(workArea.height * 0.92)));
    const { x, y } = win.getBounds();
    win.setBounds({
      x: (x + nw > workArea.x + workArea.width)  ? Math.max(workArea.x, workArea.x + workArea.width  - nw) : x,
      y: (y + nh > workArea.y + workArea.height) ? Math.max(workArea.y, workArea.y + workArea.height - nh) : y,
      width: nw, height: nh,
    });
    return { width: nw, height: nh };
  });

  ipcMain.handle('set-content-protection', (event, enabled) => {
    if (!win || win.isDestroyed()) return;
    win.setContentProtection(!!enabled);
    return { contentProtection: !!enabled };
  });
}

function registerGlobalShortcuts(win) {
  globalShortcut.unregisterAll();
  const STEP = 40;

  globalShortcut.register('CommandOrControl+B', () => {
    if (!win || win.isDestroyed()) return;
    if (windowVisible) {
      storedBounds = win.getBounds();
      applyVisibilityConfig(win, 'hidden');
      win.hide();
      windowVisible = false;
      stopOverlayInterval();
    } else {
      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      win.setAlwaysOnTop(true, 'screen-saver', 1);
      win.showInactive();
      if (storedBounds) win.setBounds(storedBounds);
      applyVisibilityConfig(win, 'visible-interactive');
      windowVisible = true;
      startOverlayInterval();
    }
  });

  globalShortcut.register('CommandOrControl+H', async () => {
    if (!win || win.isDestroyed()) return;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1200 } });
      if (sources && sources.length > 0) {
        win.webContents.send('screenshot-captured', {
          dataUrl: `data:image/png;base64,${sources[0].thumbnail.toPNG().toString('base64')}`,
        });
      }
    } catch (err) { console.error('[copilot] Cmd+H error:', err); }
  });

  const moves = {
    'CommandOrControl+Up':    (b) => [b.x,        b.y - STEP],
    'CommandOrControl+Down':  (b) => [b.x,        b.y + STEP],
    'CommandOrControl+Left':  (b) => [b.x - STEP, b.y       ],
    'CommandOrControl+Right': (b) => [b.x + STEP, b.y       ],
  };
  for (const [accel, fn] of Object.entries(moves)) {
    globalShortcut.register(accel, () => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      const [nx, ny] = fn(b);
      const { workArea } = screen.getPrimaryDisplay();
      win.setPosition(
        Math.max(workArea.x, Math.min(nx, workArea.x + workArea.width  - b.width)),
        Math.max(workArea.y, Math.min(ny, workArea.y + workArea.height - b.height)),
      );
    });
  }
}

function watchDisplayChanges(win) {
  const handler = () => {
    if (!win || win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    const b = win.getBounds();
    if (b.x + b.width > workArea.x + workArea.width || b.y + b.height > workArea.y + workArea.height) {
      win.setPosition(
        Math.max(workArea.x, Math.min(b.x, workArea.x + workArea.width  - b.width)),
        Math.max(workArea.y, Math.min(b.y, workArea.y + workArea.height - b.height)),
      );
    }
  };
  screen.on('display-added', handler);
  screen.on('display-removed', handler);
  screen.on('display-metrics-changed', handler);
}

app.whenReady().then(() => {
  try {
    const { session } = require('electron');

    // macOS 15: useSystemPicker:true means the handler below is NOT invoked on Sequoia
    // — macOS handles the picker natively. The handler is only needed as a fallback.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (sources && sources.length > 0) callback({ video: sources[0] });
        else callback(null);
      }).catch(() => callback(null));
    }, { useSystemPicker: true });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = ['media', 'microphone', 'screen', 'display-capture', 'mediaKeySystem'];
      callback(allowed.includes(permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      const allowed = ['media', 'microphone', 'screen', 'display-capture', 'mediaKeySystem'];
      return allowed.includes(permission);
    });

    protocol.registerFileProtocol('app', (request, callback) => {
      callback({ path: path.join(__dirname, '..', 'frontend', 'dist', request.url.slice('app://'.length)) });
    });

    // Start the FastAPI backend then wait for it before opening the window.
    // In dev mode (ELECTRON_DEV_URL set) the backend is already running manually.
    if (!process.env.ELECTRON_DEV_URL) {
      startBackend();
      waitForBackend(() => {
        createWindow();
      });
    } else {
      createWindow();
    }

    app.on('activate', () => {
      if (mainWindow === null) { createWindow(); }
      else if (!windowVisible) {
        mainWindow.show();
        applyVisibilityConfig(mainWindow, 'visible-interactive');
        mainWindow.focus(); windowVisible = true;
      }
    });
  } catch (err) {
    // Write crash to debug file and open window anyway
    try { fs.writeFileSync('/tmp/ic-ready-error.txt', String(err?.stack || err)); } catch(e) {}
    console.error('[app] whenReady error:', err);
    createWindow();
  }
});

app.on('window-all-closed', () => {
  // On macOS the app keeps running when all windows close (standard behaviour).
  // Do NOT stop the backend — it must stay alive for the next session.
  // Only non-macOS platforms actually quit here.
  if (process.platform !== 'darwin') {
    stopBackend();
    app.quit();
  }
  // On macOS: if backend died, restart it so it's ready for next session
  if (process.platform === 'darwin' && !backendProcess && !process.env.ELECTRON_DEV_URL) {
    setTimeout(() => {
      if (!backendProcess) startBackend();
    }, 1000);
  }
});
app.on('before-quit', () => {
  stopOverlayInterval();
  stopBackend();
  if (mainWindow && !mainWindow.isDestroyed()) storedBounds = mainWindow.getBounds();
  globalShortcut.unregisterAll();
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });




