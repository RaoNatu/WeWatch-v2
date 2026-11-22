const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron');
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
let overlayWindow;
let overlayReady = false;
let pendingOverlay = [];
let overlayConfig = { enabled: true, position: 'top-right', customX: 78, customY: 8, duration: 2000 };

const OVERLAY_WIDTH = 430;
const OVERLAY_CARD_HEIGHT = 82;
const OVERLAY_GAP = 8;
const OVERLAY_MAX_ITEMS = 4;
let overlayHeight = OVERLAY_CARD_HEIGHT;

function normalizedOverlayConfig(value = {}) {
  const positions = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'custom'];
  return {
    enabled: value.enabled !== false,
    position: positions.includes(value.position) ? value.position : 'top-right',
    customX: Math.max(0, Math.min(100, Number(value.customX) || 0)),
    customY: Math.max(0, Math.min(100, Number(value.customY) || 0)),
    duration: Math.max(1000, Math.min(6000, Number(value.duration) || 2000)),
  };
}

async function getVlcWindowBounds() {
  try {
    if (process.platform === 'win32') {
      const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public struct WWRECT { public int Left; public int Top; public int Right; public int Bottom; } public static class WWUSER32 { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WWRECT rect); }'; Get-Process vlc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $r = New-Object WWRECT; [WWUSER32]::GetWindowRect($_.MainWindowHandle, [ref]$r) | Out-Null; [pscustomobject]@{x=$r.Left; y=$r.Top; width=$r.Right-$r.Left; height=$r.Bottom-$r.Top} } | Select-Object -First 1 | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 1200, windowsHide: true });
      const value = JSON.parse(stdout.trim() || 'null');
      if (value && value.width > 0 && value.height > 0) return value;
    }
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('wmctrl', ['-lpG'], { timeout: 800 });
      const pid = vlcProcess?.pid;
      const line = stdout.split(/\r?\n/).find((entry) => {
        const fields = entry.trim().split(/\s+/);
        return fields.length >= 7 && Number(fields[2]) === pid;
      });
      if (line) {
        const fields = line.trim().split(/\s+/);
        const bounds = { x: Number(fields[3]), y: Number(fields[4]), width: Number(fields[5]), height: Number(fields[6]) };
        if (bounds.width > 0 && bounds.height > 0) return bounds;
      }
    }
  } catch {}
  return null;
}

async function positionOverlay() {
  if (!overlayWindow) return;
  const target = await getVlcWindowBounds();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
  const area = target || display.workArea;
  const { x, y, width, height } = area;
  const margin = 24;
  const maxX = x + Math.max(margin, width - OVERLAY_WIDTH - margin);
  const maxY = y + Math.max(margin, height - overlayHeight - margin);
  let left = maxX;
  let top = y + margin;
  if (overlayConfig.position === 'top-left') left = x + margin;
  if (overlayConfig.position === 'bottom-right') top = maxY;
  if (overlayConfig.position === 'bottom-left') { left = x + margin; top = maxY; }
  if (overlayConfig.position === 'custom') {
    left = x + Math.round((width - OVERLAY_WIDTH) * (overlayConfig.customX / 100));
    top = y + Math.round((height - overlayHeight) * (overlayConfig.customY / 100));
  }
  overlayWindow.setBounds({ x: left, y: top, width: OVERLAY_WIDTH, height: overlayHeight });
}

function createOverlayWindow() {
  if (overlayWindow) return;
  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_CARD_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.on('closed', () => { overlayWindow = null; overlayReady = false; });
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayReady = true;
    pendingOverlay.forEach((notification) => overlayWindow.webContents.send('overlay:show', notification));
    pendingOverlay = [];
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
}

async function showPlaybackOverlay(payload = {}) {
  if (!overlayConfig.enabled) return;
  createOverlayWindow();
  await positionOverlay();
  const action = ['play', 'pause', 'seek', 'join', 'leave'].includes(payload.action) ? payload.action : 'pause';
  const notification = {
    name: String(payload.name || 'A viewer').slice(0, 32),
    action,
    position: Math.max(0, Number(payload.position) || 0),
    duration: overlayConfig.duration,
  };
  if (overlayReady && overlayWindow && !overlayWindow.webContents.isDestroyed()) overlayWindow.webContents.send('overlay:show', notification);
  else {
    pendingOverlay.push(notification);
    if (pendingOverlay.length > OVERLAY_MAX_ITEMS) pendingOverlay.shift();
  }
  overlayWindow.showInactive();
}

ipcMain.on('overlay:config', (_event, value) => {
  overlayConfig = normalizedOverlayConfig(value);
  if (!overlayConfig.enabled) overlayWindow?.hide();
  else if (overlayWindow?.isVisible()) positionOverlay().catch(() => {});
});
ipcMain.on('overlay:resize', (_event, height) => {
  const maxHeight = OVERLAY_MAX_ITEMS * OVERLAY_CARD_HEIGHT + (OVERLAY_MAX_ITEMS - 1) * OVERLAY_GAP;
  overlayHeight = Math.max(OVERLAY_CARD_HEIGHT, Math.min(maxHeight, Number(height) || OVERLAY_CARD_HEIGHT));
  if (overlayWindow) positionOverlay().catch(() => {});
});
ipcMain.on('overlay:show', (_event, payload) => { showPlaybackOverlay(payload).catch(() => {}); });
ipcMain.on('overlay:hide', () => overlayWindow?.hide());

function finishWindowClose() {
  if (!win || allowWindowClose) return;
  allowWindowClose = true;
  clearTimeout(closeFallbackTimer);
  overlayWindow?.close();
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
