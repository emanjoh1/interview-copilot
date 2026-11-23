'use strict';

const { app, BrowserWindow, desktopCapturer, protocol, screen, ipcMain, globalShortcut } = require('electron');
const path = require('path');

let mainWindow = null;
let windowVisible = true;
let storedBounds = null;

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

  // macOS platform-specific — Ezzi's platformSpecific.darwin config
  if (process.platform === 'darwin') {
    win.setHiddenInMissionControl(true);  // hide from Mission Control / Exposé
    win.setWindowButtonVisibility(false); // hide traffic-light buttons
    win.setBackgroundColor('#00000000');
    win.setHasShadow(false);
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

    // Base settings matching Ezzi LiveInterviewConfig.baseSettings exactly.
    // KEY: NO transparent:true here — Ezzi achieves transparency via
    // backgroundColor:'#00000000' only. transparent:true + type:'panel'
    // causes the NSWindow nonactivating panel crash on macOS.
    frame:                  false,
    titleBarStyle:          'hidden',
    backgroundColor:        '#00000000',
    hasShadow:              false,
    type:                   'panel',           // excluded from SCK window lists
    alwaysOnTop:            true,
    show:                   true,
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
      webSecurity:                 true,
      allowRunningInsecureContent: false,
    },
  });

  // Apply full Ezzi-style visibility config immediately after creation.
  // This sets contentProtection, alwaysOnTop+level, visibleOnAllWorkspaces,
  // HiddenInMissionControl, etc. atomically.
  applyVisibilityConfig(mainWindow, 'visible-interactive');

  const devUrl = process.env.ELECTRON_DEV_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
  }

  // Re-apply after page loads — Zoom may start sharing while page loads
  mainWindow.webContents.once('did-finish-load', () => {
    applyVisibilityConfig(mainWindow, 'visible-interactive');
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('show', () => {
    windowVisible = true;
    // Re-apply on every show — Zoom re-enumerates windows at share start
    applyVisibilityConfig(mainWindow, 'visible-interactive');
  });
  mainWindow.on('hide', () => { windowVisible = false; });

  attachIpcHandlers(mainWindow);
  registerGlobalShortcuts(mainWindow);
  watchDisplayChanges(mainWindow);
}

function attachIpcHandlers(win) {
  const channels = [
    'toggle-visibility','show-window','capture-screenshot',
    'get-window-bounds','set-window-position','resize-window','set-content-protection',
  ];
  channels.forEach(ch => ipcMain.removeHandler(ch));

  ipcMain.handle('toggle-visibility', () => {
    if (!win || win.isDestroyed()) return { visible: false };
    if (windowVisible) {
      storedBounds = win.getBounds();
      applyVisibilityConfig(win, 'hidden');
      win.hide();
      windowVisible = false;
    } else {
      win.show();
      if (storedBounds) win.setBounds(storedBounds);
      applyVisibilityConfig(win, 'visible-interactive');
      win.focus();
      windowVisible = true;
    }
    return { visible: windowVisible };
  });

  ipcMain.handle('show-window', () => {
    if (!win || win.isDestroyed()) return;
    win.show(); if (storedBounds) win.setBounds(storedBounds);
    applyVisibilityConfig(win, 'visible-interactive');
    win.focus(); windowVisible = true;
    return { visible: true };
  });

  ipcMain.handle('capture-screenshot', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1200 } });
      if (!sources || sources.length === 0) return { error: 'No screen sources found.' };
      return { dataUrl: `data:image/png;base64,${sources[0].thumbnail.toPNG().toString('base64')}` };
    } catch (err) { return { error: err.message }; }
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
      win.hide(); windowVisible = false;
    } else {
      win.show();
      if (storedBounds) win.setBounds(storedBounds);
      applyVisibilityConfig(win, 'visible-interactive');
      win.focus(); windowVisible = true;
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
  protocol.registerFileProtocol('app', (request, callback) => {
    callback({ path: path.join(__dirname, '..', 'frontend', 'dist', request.url.slice('app://'.length)) });
  });
  createWindow();
  app.on('activate', () => {
    if (mainWindow === null) { createWindow(); }
    else if (!windowVisible) {
      mainWindow.show();
      applyVisibilityConfig(mainWindow, 'visible-interactive');
      mainWindow.focus(); windowVisible = true;
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) storedBounds = mainWindow.getBounds();
  globalShortcut.unregisterAll();
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });



