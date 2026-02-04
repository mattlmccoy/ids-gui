const { app, BrowserWindow, session, ipcMain } = require('electron');
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
