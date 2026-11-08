import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const connectorSource = readFileSync(
  resolve(__dirname, '../../connector/macos/DevinXConnector.swift'),
  'utf8',
);
const supervisorSource = readFileSync(
  resolve(__dirname, '../../connector/macos/ConnectorProcessSupervisor.swift'),
  'utf8',
);

describe('macOS Connector lifecycle', () => {
  it('explains manual installation in the update notice', () => {
    expect(connectorSource).toContain('"Check for updates"');
    expect(connectorSource).toContain('.disabled(model.isCheckingUpdate)');
    expect(connectorSource).toContain('guard !isCheckingUpdate else { return }');
    expect(connectorSource).toContain('.reloadIgnoringLocalCacheData');
    expect(connectorSource).toContain('Could not check for updates.');
    expect(connectorSource).toContain('You are up to date.');
    expect(connectorSource).toContain('Button("Download update")');
    expect(connectorSource).toContain('This update does not install automatically');
    expect(connectorSource).toContain('Applications and choose Replace');
    expect(connectorSource).toContain('Updating the iPhone app does not update Connector');
    expect(connectorSource).toContain('Your pairing is kept');
  });

  it('accepts only official release paths for the fork repository', () => {
    const officialReleasePathPrefixes = [
      '/tourproapp/Otterin/releases/',
    ];
    const isOfficialReleasePath = (path: string) =>
      officialReleasePathPrefixes.some((prefix) => path.startsWith(prefix));

    expect(connectorSource).toContain(
      'connectorReleaseApi = URL(string: "https://api.github.com/repos/tourproapp/Otterin/releases/latest")!',
    );
    expect(connectorSource).toContain('let officialReleasePathPrefixes = [');
    for (const prefix of officialReleasePathPrefixes) {
      expect(connectorSource).toContain(`"${prefix}"`);
    }
    expect(connectorSource).toContain(
      'officialReleasePathPrefixes.contains { components.path.hasPrefix($0) }',
    );
    expect(isOfficialReleasePath('/tourproapp/Otterin/releases/download/connector-v0.1.17')).toBe(true);
    expect(isOfficialReleasePath('/fenner888/Devinx/releases/download/connector-v0.1.17')).toBe(false);
    expect(isOfficialReleasePath('/fenner888/Otterin/releases/download/connector-v0.1.17')).toBe(false);
    expect(isOfficialReleasePath('/tourproapp/Otterin-evil/releases/latest')).toBe(false);
    expect(isOfficialReleasePath('/someoneelse/Otterin/releases/latest')).toBe(false);
    expect(isOfficialReleasePath('/tourproapp/Otterin/releases-evil/latest')).toBe(false);
  });

  it('keeps the runtime available after the window closes and exposes explicit menu actions', () => {
    expect(connectorSource).toMatch(
      /applicationShouldTerminateAfterLastWindowClosed[\s\S]*?\n\s*false/,
    );
    expect(connectorSource).toContain('window.isReleasedWhenClosed = false');
    expect(connectorSource).toContain('NSStatusBar.system.statusItem');
    expect(connectorSource).toContain('Open Otterin Connector');
    expect(connectorSource).toContain('Quit Otterin Connector');
    expect(connectorSource).toContain('NSApplication.shared.setActivationPolicy(.accessory)');
  });

  it('can remove protected state when the bridge runtime is unavailable during uninstall', () => {
    expect(connectorSource).toContain('private func removeProtectedStateWithHelper()');
    expect(connectorSource).toContain(
      'task.arguments = ["delete", keychainService, keychainAccount]',
    );
    expect(connectorSource).toMatch(
      /private func runtimeDidTerminate\(_ terminationStatus: Int32\) \{[\s\S]*?if uninstalling \{[\s\S]*?removeProtectedStateWithHelper\(\)/,
    );
    expect(connectorSource).toMatch(
      /if runtime\.isRunning \{[\s\S]*?type": "reset"[\s\S]*?\} else \{[\s\S]*?removeProtectedStateWithHelper\(\)/,
    );
  });

  it('owns stdout and stderr handlers in one idempotent cleanup path', () => {
    expect(connectorSource).toContain('private let runtime = ConnectorProcessSupervisor()');
    expect(supervisorSource).toContain('private func handleEOF');
    expect(supervisorSource).toContain('private func finish');
    expect(supervisorSource).toContain('context.cleaned = true');
    expect(supervisorSource).toContain('readabilityHandler = nil');
    expect(supervisorSource).toContain('close(context.error.fileHandleForWriting)');
  });

  it('shows the newest paired device first and marks that row as most recent', () => {
    expect(connectorSource).toContain('$0.pairedAt > $1.pairedAt');
    expect(connectorSource).toContain('let activeDevices = model.devices.filter { $0.status == "active" }');
    expect(connectorSource).toContain('let keep = activeDevices.first');
    expect(connectorSource).toContain('let older = Array(activeDevices.dropFirst())');
    expect(connectorSource).toContain('device.id == keep?.id');
  });

  it('warns before revoking older active devices and uses the existing revoke command', () => {
    expect(connectorSource).toContain(
      'Image(systemName: "exclamationmark.triangle.fill")',
    );
    expect(connectorSource).toContain('Revoke older devices…');
    expect(connectorSource).toContain(
      '"Revoke \\(older.count) older device\\(older.count == 1 ? "" : "s")?"',
    );
    expect(connectorSource).toContain(
      '"\\(older.count) older device\\(older.count == 1 ? "" : "s") can still connect to this Mac. Revoke any you no longer use."',
    );
    expect(connectorSource).toContain(
      '"Only \\(keep.deviceName), paired \\(Date(timeIntervalSince1970: keep.pairedAt / 1_000).formatted(date: .abbreviated, time: .shortened)), stays connected. Revoked devices must pair again."',
    );
    expect(connectorSource).toContain('model.revokeDevices(older)');
    expect(connectorSource).toContain('func revokeDevices(_ devices: [ConnectorDevice])');
    expect(connectorSource).toMatch(
      /func revokeDevices\(_ devices: \[ConnectorDevice\]\) \{[\s\S]*?for device in devices \{[\s\S]*?revokeDevice\(device\)/,
    );
    expect(connectorSource).toContain('"type": "revoke_device"');
  });

  it('invalidates QR presentation on stop and termination and clears expired review state', () => {
    expect(connectorSource).toMatch(/func stop\(\) \{\s*clearPairingCode\(\)/);
    expect(connectorSource).toMatch(/func runtimeDidTerminate[^{]+\{\s*clearPairingCode\(\)/);
    expect(connectorSource).toMatch(/case "pairing_offer":[\s\S]*?pendingPairingId = nil/);
    expect(connectorSource).toContain('pairingCodeLifetime.consumeExpiry(now: Date())');
    expect(connectorSource).toContain(
      'In Otterin: Your computer → Pair a computer → Scan pairing code',
    );
    expect(connectorSource).not.toContain('Settings → Computers');
  });

  it('decodes and shows the pairing review device-key fingerprint', () => {
    expect(connectorSource).toContain('let deviceKeyFingerprint: String?');
    expect(connectorSource).toContain('@Published var pendingDeviceKeyFingerprint: String?');
    expect(connectorSource).toContain(
      'pendingDeviceKeyFingerprint = event.deviceKeyFingerprint',
    );
    expect(connectorSource).toContain('"Key fingerprint: \\(fingerprint)"');
    expect(connectorSource).toContain('Button("Approve device") { model.approve() }');
  });
});
