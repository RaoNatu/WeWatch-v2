const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const net = require('node:net');

const execFileAsync = promisify(execFile);
let win;
let vlcProcess;
let vlcPort;
let vlcPassword;
let vlcBinary;
let vlcLookupDone = false;
let vlcSpawnError;
let closingWindow = false;
let allowWindowClose = false;
let closeFallbackTimer;

function finishWindowClose() {
  if (!win || allowWindowClose) return;
  allowWindowClose = true;
  clearTimeout(closeFallbackTimer);
  win.close();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#111210',
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#111210', symbolColor: '#d9e0d1', height: 36 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('close', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (closingWindow) return;
    closingWindow = true;
    win.webContents.send('app:before-close');
    closeFallbackTimer = setTimeout(finishWindowClose, 8000);
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged ? 'http://127.0.0.1:5173' : null);
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

ipcMain.on('app:close-cleanup-done', finishWindowClose);

async function findVlc() {
  if (vlcLookupDone) return vlcBinary;
  vlcLookupDone = true;
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe']
    : ['/usr/bin/vlc', '/usr/local/bin/vlc', '/snap/bin/vlc'];
  for (const candidate of candidates) {
    try { await execFileAsync(candidate, ['--version'], { timeout: 2000, windowsHide: true }); vlcBinary = candidate; return candidate; } catch {}
  }
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', ['vlc'], { timeout: 2000, windowsHide: true });
    vlcBinary = stdout.trim().split(/\r?\n/)[0] || null;
    return vlcBinary;
  } catch { return null; }
}

async function processRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq vlc.exe', '/NH'], { windowsHide: true });
      return /vlc\.exe/i.test(stdout);
    }
    for (const processName of ['vlc', 'vlc-bin']) {
      try { const { stdout } = await execFileAsync('pgrep', ['-x', processName]); if (stdout.trim()) return true; } catch {}
    }
    return false;
  } catch { return false; }
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function launchVlc(filePath) {
  vlcBinary = vlcBinary || await findVlc();
  if (!vlcBinary) throw new Error('VLC was not found. Install VLC media player and try again.');
  if (vlcProcess && vlcProcess.exitCode === null) {
    if (filePath) await vlcCommand('in_play', pathToFileURL(filePath).href);
    return { running: true, managed: true };
  }
  vlcPort = await availablePort();
  vlcPassword = crypto.randomBytes(18).toString('hex');
  const args = ['--extraintf', 'http', '--http-host', '127.0.0.1', '--http-port', String(vlcPort), '--http-password', vlcPassword, '--no-video-title-show'];
  if (filePath) args.push(filePath);
  vlcSpawnError = null;
  vlcProcess = spawn(vlcBinary, args, { detached: false, windowsHide: true, stdio: 'ignore' });
  vlcProcess.on('exit', () => { vlcProcess = null; });
  vlcProcess.on('error', (error) => { vlcSpawnError = error; });
  await new Promise((resolve) => setTimeout(resolve, 900));
  if (vlcSpawnError) throw new Error(`Could not start VLC: ${vlcSpawnError.message}`);
  if (!vlcProcess || vlcProcess.exitCode !== null) throw new Error('VLC closed before its sync server could start.');
  return { running: true, managed: true };
}

async function vlcCommand(command, value) {
  if (!vlcPort || !vlcPassword) throw new Error('Start VLC from WeWatch before controlling playback.');
  const url = new URL(`http://127.0.0.1:${vlcPort}/requests/status.json`);
  if (command) url.searchParams.set('command', command);
  if (value !== undefined) url.searchParams.set(command === 'seek' ? 'val' : 'input', value);
  const response = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`:${vlcPassword}`).toString('base64')}` },
    signal: AbortSignal.timeout(1800),
  });
  if (!response.ok) throw new Error(`VLC returned ${response.status}`);
  return response.json();
}

ipcMain.handle('vlc:status', async () => ({ installed: Boolean(vlcBinary || await findVlc()), running: await processRunning(), managed: Boolean(vlcProcess && vlcProcess.exitCode === null) }));
ipcMain.handle('vlc:start', async () => launchVlc());
ipcMain.handle('vlc:pick-media', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Choose a movie', properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'mpeg', 'mpg'] }, { name: 'All files', extensions: ['*'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = result.filePaths[0];
  await launchVlc(selected);
  return { name: path.basename(selected) };
});
ipcMain.handle('vlc:control', async (_event, payload) => {
  if (payload.action === 'play' || payload.action === 'pause') {
    const state = await vlcCommand('');
    if (payload.action === 'play' && state.state === 'playing') return state;
    if (payload.action === 'pause' && state.state !== 'playing') return state;
    return vlcCommand(payload.action === 'play' ? 'pl_play' : 'pl_pause');
  }
  if (payload.action === 'seek') return vlcCommand('seek', String(Math.max(0, Math.floor(payload.seconds))));
  return null;
});
ipcMain.handle('vlc:read', async () => {
  try { return await vlcCommand(''); } catch { return null; }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
