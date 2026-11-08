import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';

// Argv hygiene — refuse debug/injection flags before anything else runs.
const FORBIDDEN_ARGV = ['--inspect', '--inspect-brk', '--remote-debugging-port', '--js-flags'];
if (process.argv.some((arg) => FORBIDDEN_ARGV.some((flag) => arg.startsWith(flag)))) {
  app.exit(1);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.argv.includes('--dev')) {
    void win.loadURL('http://localhost:5180');
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
  callback(false);
});

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

void shell; // referenced for future external-URL allowlist
