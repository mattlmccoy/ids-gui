const { app, BrowserWindow, session, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const ARDUINO_VENDOR_ID = 0x2341;

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.removeMenu();
  startLocalServer().then((port) => {
    win.loadURL(`http://127.0.0.1:${port}/`);
  });
}

app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-features', 'Serial');

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    if (permission === 'serial') return callback(true);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_, permission) => {
    return permission === 'serial';
  });
  session.defaultSession.setDevicePermissionHandler(details => {
    if (details.deviceType === 'serial') return true;
    return false;
  });
  let pendingSerialSelect = null;

  ipcMain.on('serial-port-select', (_evt, { portId }) => {
    if (pendingSerialSelect) {
      pendingSerialSelect.callback(portId || '');
      pendingSerialSelect = null;
    }
  });
  ipcMain.on('serial-port-cancel', () => {
    if (pendingSerialSelect) {
      pendingSerialSelect.callback('');
      pendingSerialSelect = null;
    }
  });

  session.defaultSession.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (!portList || portList.length === 0) return callback('');
    const match = portList.find(p => {
      const vid = typeof p.vendorId === 'string' ? parseInt(p.vendorId, 16) : p.vendorId;
      return vid === ARDUINO_VENDOR_ID;
    });
    if (match && portList.length === 1) {
      callback(match.portId);
      return;
    }
    // Auto-select preferred device if only one, otherwise prompt user
    if (match && portList.length > 1) {
      // still allow user choice when multiple devices exist
    }
    pendingSerialSelect = { callback, webContents };
    webContents.send('serial-port-list', portList);
  });

  const inkFilePath = () => path.join(app.getPath('userData'), 'ink-check-data.json');

  ipcMain.handle('ink-data-load-default', async () => {
    const filePath = inkFilePath();
    try {
      if (!fs.existsSync(filePath)) return { ok: true, exists: false, filePath, data: null };
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      return { ok: true, exists: true, filePath, data };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), filePath };
    }
  });

  ipcMain.handle('ink-data-save-default', async (_evt, payload) => {
    const filePath = inkFilePath();
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: String(err?.message || err), filePath };
    }
  });

  ipcMain.handle('ink-data-import-json', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const pick = await dialog.showOpenDialog(win, {
        title: 'Load Ink Data JSON',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (pick.canceled || !pick.filePaths?.length) return { ok: true, canceled: true };
      const filePath = pick.filePaths[0];
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      return { ok: true, canceled: false, filePath, data };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('ink-data-export-json', async (_evt, payload) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const save = await dialog.showSaveDialog(win, {
        title: 'Export Ink Data JSON',
        defaultPath: 'ink-check-data.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (save.canceled || !save.filePath) return { ok: true, canceled: true };
      await fs.promises.writeFile(save.filePath, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, canceled: false, filePath: save.filePath };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function startLocalServer() {
  return new Promise((resolve) => {
    const root = __dirname;
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end('Not found');
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime = {
          '.html': 'text/html',
          '.css': 'text/css',
          '.js': 'text/javascript',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf'
        }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve(port);
    });
  });
}
