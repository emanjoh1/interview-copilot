// capture.js - Silent audio capture from screen share
let isCapturing = false;

async function invokeIPC(channel, ...args) {
  if (!window.electron || !window.electron.ipcRenderer) {
    throw new Error('Electron not available');
  }
  return await window.electron.ipcRenderer.invoke(channel, ...args);
}

function updateStatus(message) {
  const statusEl = document.getElementById('status');
  if (message) statusEl.textContent = message;
}

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
let isHiddenCapturing = false;

startBtn.addEventListener('click', async () => {
  updateStatus('Connecting...');
  try {
    const result = await invokeIPC('start-audio-capture');
    if (result.status === 'started') {
      // Try to capture audio from system/Zoom screen share
      isCapturing = true;
      isHiddenCapturing = false; 
      startBtn.disabled = true;
      stopBtn.disabled = false;
      updateStatus('🎙️ Capturing from Zoom/Teams');
    }
  } catch (err) {
    updateErr('Error: ' + err.message);
    isCapturing = false;
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    const result = await invokeIPC('stop-audio-capture');
    isHiddenCapturing = false;
    stopBtn.disabled = true;
    updateStatus(result.status === 'stopped' ? 'Capture stopped' : 'Failed');
  } catch (err) {
    updateErr('Error: ' + err.message);
  }
});
