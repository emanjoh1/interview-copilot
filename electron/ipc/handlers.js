// ipc/handlers.js
// NOTE: All IPC handlers are now registered directly in electron/main.js
// (via attachIpcHandlers) so they have a typed reference to the BrowserWindow
// instance and do not need to reach back through getFocusedWindow().
//
// This file is kept as a placeholder. Any future feature-specific IPC
// handlers that are too large for main.js can be moved here as named
// exported functions that accept (ipcMain, win) parameters, e.g.:
//
//   module.exports = function registerFeatureHandlers(ipcMain, win) { … }
//
// Then imported and called from createWindow() in main.js.
'use strict';

// No-op export — prevents require() errors if anything still imports this file.
module.exports = {};
