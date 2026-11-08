// Otterin for Mac — Electron main process (PLAN §2, §7, §8).
//
// Hardening notes:
//   - Argv hygiene + single-instance + ignored second-instance argv below.
//   - Electron fuses (must be flipped at packaging time — electron-builder
//     afterPack hook in scripts/, owned by the packaging milestone):
//       RunAsNode=off, EnableNodeOptionsEnvironmentVariable=off,
//       EnableNodeCliInspectArguments=off, EnableCookieEncryption=on.
//     RunAsNode/NodeOptions/CliInspect are main-process injection vectors
//     for key material; asar-integrity is NOT claimed (it cannot function
//     unsigned).
//   - crashReporter is intentionally NOT enabled: spec 021 bans the pairing
//     payload in crash reports and minidumps capture in-memory key
//     material.
//   - Never logged or persisted: private key, pairingSecret, pollToken,
//     offer payload, signatures, session content, endpoint. console output
//     in main is audit-level only.

import { app, BrowserWindow, screen, session } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { initializeClientCorePorts, requireClientCoreProtocol } from './client-core-wiring';
import { registerIpcHandlers } from './ipc';
import { notifyPendingInteractions } from './notifications';
import { initSecrets } from './secrets.mac';
import { PollScheduler } from './scheduler';

// Argv hygiene — refuse debug/injection flags before anything else runs.
const FORBIDDEN_ARGV = ['--inspect', '--inspect-brk', '--remote-debugging-port', '--js-flags'];
if (process.argv.some((arg) => FORBIDDEN_ARGV.some((flag) => arg.startsWith(flag)))) {
  app.exit(1);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// App identity before the first notification can post (attribution) and so
// safeStorage binds to "Otterin Safe Storage", not a Chromium default.
app.setName('Otterin');
if (typeof app.setAppUserModelId === 'function') {
  app.setAppUserModelId('com.tourproapp.otterin');
}

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

// -- client-core ports --------------------------------------------------------
// Registration is reference-only — safe before any window exists. The
// safeStorage blob store stays inert until initSecrets() runs from the
// window's ready-to-show handler (Electron #34614 bind hazard).
initializeClientCorePorts();

// -- scheduler ----------------------------------------------------------------

const scheduler = new PollScheduler({
  resolveConnection: (bridgeId) => requireClientCoreProtocol().openBridge(bridgeId),
  onPending: (pending) => notifyPendingInteractions(pending),
});

// -- window state persistence -------------------------------------------------

const windowStateSchema = z
  .object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().min(960).max(16_384),
    height: z.number().int().min(600).max(16_384),
  })
  .strict();

type WindowState = z.infer<typeof windowStateSchema>;
const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 800 };

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  try {
    const parsed = windowStateSchema.safeParse(
      JSON.parse(readFileSync(windowStatePath(), 'utf8')),
    );
    if (parsed.success && stateVisibleOnSomeDisplay(parsed.data)) {
      return parsed.data;
    }
  } catch {
    // Missing or corrupt state file — fall through to defaults.
  }
  return DEFAULT_WINDOW_STATE;
}

function stateVisibleOnSomeDisplay(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) {
    return true; // size-only state — Electron centers the window.
  }
  const bounds = { x: state.x, y: state.y, width: state.width, height: state.height };
  return screen
    .getAllDisplays()
    .some((display) => {
      const area = display.workArea;
      return (
        bounds.x < area.x + area.width &&
        bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height &&
        bounds.y + bounds.height > area.y
      );
    });
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) {
    return;
  }
  try {
    const bounds = win.getBounds();
    const state: WindowState = bounds;
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(windowStatePath(), JSON.stringify(state), 'utf8');
  } catch {
    // Best-effort — a failed write is never worth a crash.
  }
}

// -- window -------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let secretsInitialized = false;

function createWindow(): void {
  const restored = loadWindowState();
  const win = new BrowserWindow({
    x: restored.x,
    y: restored.y,
    width: restored.width,
    height: restored.height,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
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
  mainWindow = win;

  win.once('ready-to-show', () => {
    win.show();
    if (!secretsInitialized) {
      // First-window-ready is the earliest safe safeStorage bind point.
      try {
        initSecrets();
        secretsInitialized = true;
      } catch (error) {
        console.error(
          '[secrets] OS encryption unavailable:',
          error instanceof Error ? error.message : 'unknown',
        );
      }
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Visibility cadence for the poll scheduler: focused/shown = foreground.
  win.on('blur', () => scheduler.setForeground(false));
  win.on('focus', () => scheduler.setForeground(!win.isDestroyed() && win.isVisible()));
  win.on('hide', () => scheduler.setForeground(false));
  win.on('show', () => scheduler.setForeground(true));

  let saveTimer: NodeJS.Timeout | null = null;
  const persistStateSoon = () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => saveWindowState(win), 500);
  };
  win.on('resize', persistStateSoon);
  win.on('move', persistStateSoon);
  win.on('close', () => saveWindowState(win));

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  if (process.argv.includes('--dev')) {
    void win.loadURL('http://localhost:5180');
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  // Deny every renderer permission request (camera, notifications via the
  // web path, etc.) — the app uses its own Notification path in main.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerIpcHandlers({
    getWindow: () => mainWindow,
    scheduler,
  });
  scheduler.start();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Second-instance argv is ignored by design (PLAN §8) — only refocus.
app.on('second-instance', () => {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  // On macOS the app stays alive for the background list poll (badge +
  // notifications); only other platforms quit.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  scheduler.stop();
});
