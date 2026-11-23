// preload.js — InterviewCopilot IPC bridge
// Exposes a narrow, validated API to the renderer via contextBridge.
// nodeIntegration is disabled; this is the only channel between renderer and main.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilot', {
  // ── Session transcript storage ────────────────────────────────────────────
  saveSession:        (data: object) => ipcRenderer.invoke('save-session', data),
  listSessions:       () => ipcRenderer.invoke('list-sessions'),
  loadSession:        (filename: string) => ipcRenderer.invoke('load-session', filename),
  openSessionsFolder: () => ipcRenderer.invoke('open-sessions-folder'),

  // ── Window controls ───────────────────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow:    () => ipcRenderer.invoke('close-window'),

  // ── Visibility ────────────────────────────────────────────────────────────
  // Returns { visible: boolean }
  toggleVisibility: () => ipcRenderer.invoke('toggle-visibility'),
  showWindow:       () => ipcRenderer.invoke('show-window'),

  // ── Screenshot ────────────────────────────────────────────────────────────
  // Returns { dataUrl: string } or { error: string }
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),

  // ── Window geometry ───────────────────────────────────────────────────────
  // Returns { x, y, width, height }
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  // Move to absolute position; main clamps to work area
  setWindowPosition: (x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    return ipcRenderer.invoke('set-window-position', Math.round(x), Math.round(y));
  },
  // Request a new width/height; main clamps and re-centers if needed
  resizeWindow: (width, height) => {
    if (typeof width !== 'number' || typeof height !== 'number') return;
    return ipcRenderer.invoke('resize-window', Math.round(width), Math.round(height));
  },

  // ── Content protection ────────────────────────────────────────────────────
  // Pass false to temporarily allow the user to share their own screen
  setContentProtection: (enabled) =>
    ipcRenderer.invoke('set-content-protection', !!enabled),

  // ── Main → renderer push events ───────────────────────────────────────────
  // Register a one-time or persistent listener for Cmd+H screenshot push.
  // callback receives { dataUrl: string }
  onScreenshot: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('screenshot-captured', (_event, payload) => callback(payload));
  },
  // Remove all screenshot listeners
  offScreenshot: () => {
    ipcRenderer.removeAllListeners('screenshot-captured');
  },
});

