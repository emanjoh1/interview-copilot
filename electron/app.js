// app.js - Main window script
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

async function invokeIPC(channel, ...args) {
  if (!window.electron || !window.electron.ipcRenderer) {
    throw new Error('Electron not available');
  }
  return await window.electron.ipcRenderer.invoke(channel, ...args);
}

function updateUI(message) {
  if (message) statusEl.textContent = message;
}

startBtn.addEventListener('click', async () => {
  try {
    updateUI('Connecting...');
    const result = await invokeIPC('start-audio-capture');
    if (result.status === 'started') {
      isCapturing = true;
      updateUI('✅ Capturing from screen share');
    }
  } catch (err) {
    updateErr('Error: ' + err.message);
    isCapturing = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    const result = await invokeIPC('stop-audio-capture');
    isCapturing = false;
    updateUI(result.status === 'stopped' ? 'Capture stopped' : 'Failed');
  } catch (err) {
    updateErr('Error: ' + err.message);
  }
});
