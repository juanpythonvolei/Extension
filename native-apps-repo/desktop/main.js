const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, nativeImage, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let mainWindow = null;
let tray = null;
let bridgeProc = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

function getUserConfigPath() {
  return path.join(app.getPath('userData'), 'continuum-config.json');
}

function loadConfig() {
  const defaultCfgPath = path.join(__dirname, 'config.json');
  let base = { serverUrl: 'https://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app', roomCode: 'MESH01' };
  try {
    base = { ...base, ...JSON.parse(fs.readFileSync(defaultCfgPath, 'utf8')) };
  } catch {
    // ignore
  }
  try {
    const userPath = getUserConfigPath();
    if (fs.existsSync(userPath)) {
      base = { ...base, ...JSON.parse(fs.readFileSync(userPath, 'utf8')) };
    }
  } catch {
    // ignore
  }
  base.serverUrl = String(base.serverUrl || '').replace(/\/+$/, '');
  base.roomCode = String(base.roomCode || 'MESH01').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MESH01';
  return base;
}

function saveConfig(cfg) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getUserConfigPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function getWsUrl(serverUrl) {
  try {
    const parsed = new URL(serverUrl);
    const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + parsed.host + '/ws';
  } catch {
    return 'wss://ais-pre-a6iomfzcjhr5udpk6kpqgs-702819737353.us-east1.run.app/ws';
  }
}

function getBridgeResourcePath(fileName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bridge', fileName);
  }
  return path.join(__dirname, 'bridge', fileName);
}

function getBridgeLogPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Continuum', 'bridge.log');
  }
  return path.join(os.homedir(), '.local', 'share', 'continuum', 'bridge.log');
}

function stopBridge() {
  if (bridgeProc) {
    try {
      bridgeProc.kill();
    } catch {
      // ignore
    }
    bridgeProc = null;
  }
}

function startBridge(cfg) {
  stopBridge();
  const wsUrl = getWsUrl(cfg.serverUrl);
  const env = {
    ...process.env,
    CONTINUUM_ROOM_CODE: cfg.roomCode,
    CONTINUUM_WS_URL: wsUrl,
    CONTINUUM_APP_URL: cfg.serverUrl + '/?room=' + encodeURIComponent(cfg.roomCode),
  };

  if (process.platform === 'linux') {
    const script = getBridgeResourcePath('continuum_bridge.py');
    if (fs.existsSync(script)) {
      bridgeProc = spawn('python3', [script], { env, stdio: 'ignore' });
      bridgeProc.on('exit', () => {
        bridgeProc = null;
      });
    }
  } else if (process.platform === 'win32') {
    const script = getBridgeResourcePath('ContinuumBridge.ps1');
    if (fs.existsSync(script)) {
      bridgeProc = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
        { env, windowsHide: true, stdio: 'ignore' }
      );
      bridgeProc.on('exit', () => {
        bridgeProc = null;
      });
    }
  }
}

function openConfigPrompt() {
  const cfg = loadConfig();
  const promptWin = new BrowserWindow({
    width: 480,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: mainWindow || undefined,
    modal: Boolean(mainWindow),
    backgroundColor: '#090B0E',
    title: 'Configurar Servidor e Malha — Continuum',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const html = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><style>
body{margin:0;padding:20px;background:#090B0E;color:#F1F5F9;font-family:system-ui,sans-serif;font-size:13px}
label{display:block;color:#94A3B8;margin:12px 0 4px;font-size:12px}
input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:6px;border:1px solid #222936;background:#11151B;color:#F1F5F9;font-family:monospace;font-size:12px}
.row{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
button{padding:8px 14px;border-radius:6px;border:1px solid #222936;background:#171C24;color:#F1F5F9;cursor:pointer;font-size:12px}
button.primary{background:#3B82F6;border-color:#3B82F6;color:#fff}
</style></head>
<body>
  <strong style="font-size:15px">Servidor e Malha do Continuum</strong>
  <form id="f">
    <label>URL do Servidor (https://... ou http://IP:3000)</label>
    <input id="url" type="url" required value="${cfg.serverUrl.replace(/"/g, '&quot;')}" />
    <label>Codigo da Malha (4 a 8 caracteres)</label>
    <input id="room" type="text" required maxlength="8" value="${cfg.roomCode.replace(/"/g, '&quot;')}" />
    <div class="row">
      <button type="button" onclick="window.close()">Cancelar</button>
      <button type="submit" class="primary">Salvar e Reconectar</button>
    </div>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', (e) => {
      e.preventDefault();
      const u = encodeURIComponent(document.getElementById('url').value.trim());
      const r = encodeURIComponent(document.getElementById('room').value.trim());
      window.location.href = 'continuum-cfg://save?url=' + u + '&room=' + r;
    });
  </script>
</body></html>`;

  promptWin.webContents.on('will-navigate', (ev, targetUrl) => {
    if (targetUrl.startsWith('continuum-cfg://save')) {
      ev.preventDefault();
      try {
        const parsed = new URL(targetUrl);
        const nextUrl = String(parsed.searchParams.get('url') || cfg.serverUrl).replace(/\/+$/, '');
        const nextRoom = String(parsed.searchParams.get('room') || cfg.roomCode)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 8);
        if (nextUrl.startsWith('http://') || nextUrl.startsWith('https://')) {
          const updated = { serverUrl: nextUrl, roomCode: nextRoom || cfg.roomCode };
          saveConfig(updated);
          startBridge(updated);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(updated.serverUrl + '/?room=' + encodeURIComponent(updated.roomCode));
          }
        }
      } catch {
        // ignore
      }
      promptWin.close();
    }
  });

  promptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow() {
  const cfg = loadConfig();
  const iconPath = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#090B0E',
    title: 'Continuum',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Enable native getDisplayMedia() capture for Second Screen inside Electron
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      if (sources.length > 0) {
        callback({ video: sources[0] });
        return;
      }
    } catch {
      // fallback
    }
    callback({});
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (ev) => {
    if (!isQuitting && tray) {
      ev.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadURL(cfg.serverUrl + '/?room=' + encodeURIComponent(cfg.roomCode));
  startBridge(cfg);
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 }) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Continuum — Ecossistema Multiplataforma');

  const rebuildMenu = () => {
    const cfg = loadConfig();
    const menu = Menu.buildFromTemplate([
      {
        label: 'Abrir Continuum',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      { label: 'Malha atual: ' + cfg.roomCode, enabled: false },
      { type: 'separator' },
      { label: 'Alterar Servidor / Malha...', click: openConfigPrompt },
      {
        label: 'Abrir Log da Ponte Nativa',
        click: () => {
          const logPath = getBridgeLogPath();
          if (fs.existsSync(logPath)) {
            shell.openPath(logPath);
          } else {
            dialog.showMessageBox({ message: 'O log sera criado em: ' + logPath });
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Encerrar Continuum',
        click: () => {
          isQuitting = true;
          stopBridge();
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };

  rebuildMenu();
  tray.on('click', () => {
    rebuildMenu();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBridge();
});
