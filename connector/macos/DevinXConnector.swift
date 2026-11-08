import AppKit
import Combine
import CoreImage
import CoreImage.CIFilterBuiltins
import ServiceManagement
import SwiftUI

private let ipcVersion = 1
private let keychainService = "com.devinx.desktop-bridge"
private let keychainAccount = "bridge-state-v1"
private let connectorReleaseApi = URL(string: "https://api.github.com/repos/tourproapp/Otterin/releases/latest")!

private struct ConnectorRelease: Decodable, Equatable, Sendable {
    let tagName: String
    let htmlUrl: String

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlUrl = "html_url"
    }
}

private struct ConnectorDevice: Decodable, Identifiable {
    let deviceId: String
    let deviceName: String
    let pairedAt: Double
    let status: String
    let allowSessionContent: Bool
    let allowSessionPrompt: Bool
    let allowSessionCreate: Bool
    var id: String { deviceId }
}

private struct ConnectorEvent: Decodable {
    let version: Int
    let type: String
    let payload: String?
    let expiresAt: Double?
    let transport: String?
    let sessionDiscoveryEnabled: Bool?
    let cliDetected: Bool?
    let pairingId: String?
    let deviceName: String?
    let deviceKeyFingerprint: String?
    let access: String?
    let code: String?
    let route: String?
    let phase: String?
    let status: Int?
    let devices: [ConnectorDevice]?
}

private enum ConnectorStatus: Equatable {
    case starting
    case ready
    case awaitingApproval
    case paired
    case uninstalling
    case failed(String)

    var label: String {
        switch self {
        case .starting: return "Starting securely…"
        case .ready: return "Ready to connect"
        case .awaitingApproval: return "Review this device"
        case .paired: return "Device connected"
        case .uninstalling: return "Removing securely…"
        case .failed: return "Needs attention"
        }
    }

    var symbol: String {
        switch self {
        case .starting: return "hourglass"
        case .ready: return "checkmark.circle.fill"
        case .awaitingApproval: return "iphone.and.arrow.forward"
        case .paired: return "checkmark.shield.fill"
        case .uninstalling: return "trash.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }
}

@MainActor
private final class ConnectorModel: ObservableObject {
    @Published var status: ConnectorStatus = .starting
    @Published var qrImage: NSImage?
    @Published var qrExpiresAt: Date?
    @Published var transportLabel = "Detecting private network…"
    @Published var cliDetected = false
    @Published var sessionDiscoveryEnabled = false
    @Published var pendingDeviceName: String?
    @Published var pendingDeviceKeyFingerprint: String?
    @Published var pendingPairingId: String?
    @Published var allowSessionContent = false
    @Published var launchAtLogin = false
    @Published var pairingDiagnostic: String?
    @Published var devices: [ConnectorDevice] = []
    @Published var showingUninstallConfirmation = false
    @Published var availableUpdate: ConnectorRelease?
    @Published var isCheckingUpdate = false
    @Published var updateCheckMessage: String?

    private let runtime = ConnectorProcessSupervisor()
    private var outputBuffer = Data()
    private let maximumBufferedBytes = 65_536
    private var uninstalling = false
    private var uninstallFallbackRunning = false
    private var protectedStateRemovalConfirmed = false
    private var pairingCodeLifetime = ConnectorPairingCodeLifetime()
    private var pairingExpiryTask: Task<Void, Never>?

    init() {
        runtime.onOutput = { [weak self] data in
            Task { @MainActor in self?.consume(data) }
        }
        runtime.onError = { _ in
            // Stderr must be drained so the child cannot block, but runtime
            // diagnostics are intentionally not persisted or logged.
        }
        runtime.onTermination = { [weak self] status in
            Task { @MainActor in self?.runtimeDidTerminate(status) }
        }
        refreshLaunchAtLogin()
        start()
        checkForUpdate()
    }

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
    }

    func checkForUpdate() {
        guard !isCheckingUpdate else { return }
        isCheckingUpdate = true
        updateCheckMessage = nil
        let installedVersion = currentVersion
        var request = URLRequest(url: connectorReleaseApi)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("DevinX-Connector/\(installedVersion)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard
                let data,
                let http = response as? HTTPURLResponse,
                http.statusCode == 200,
                data.count <= 64_000,
                let release = try? JSONDecoder().decode(ConnectorRelease.self, from: data),
                let releaseVersion = Self.version(from: release.tagName),
                let currentParts = Self.versionParts(installedVersion),
                Self.isOfficialReleaseUrl(release.htmlUrl)
            else {
                Task { @MainActor in
                    self?.isCheckingUpdate = false
                    self?.updateCheckMessage = "Could not check for updates. Check your connection and try again."
                }
                return
            }
            let newer = Self.isNewer(releaseVersion, than: currentParts)
            Task { @MainActor in
                self?.isCheckingUpdate = false
                self?.availableUpdate = newer ? release : nil
                self?.updateCheckMessage = newer
                    ? "An update is available. Download and install it on this Mac."
                    : "You are up to date."
            }
        }.resume()
    }

    func openAvailableUpdate() {
        guard
            let value = availableUpdate?.htmlUrl,
            Self.isOfficialReleaseUrl(value),
            let url = URL(string: value)
        else { return }
        NSWorkspace.shared.open(url)
    }

    nonisolated private static func version(from tag: String) -> [Int]? {
        guard tag.hasPrefix("connector-v") else { return nil }
        return versionParts(String(tag.dropFirst("connector-v".count)))
    }

    nonisolated private static func versionParts(_ value: String) -> [Int]? {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        let numbers = parts.compactMap { Int($0) }
        guard numbers.count == 3, numbers.allSatisfy({ $0 >= 0 }) else { return nil }
        return numbers
    }

    nonisolated private static func isNewer(_ candidate: [Int], than current: [Int]) -> Bool {
        for index in 0..<3 where candidate[index] != current[index] {
            return candidate[index] > current[index]
        }
        return false
    }

    nonisolated private static func isOfficialReleaseUrl(_ value: String) -> Bool {
        guard let components = URLComponents(string: value) else { return false }
        let officialReleasePathPrefixes = [
            "/tourproapp/Otterin/releases/",
        ]
        return components.scheme == "https" &&
            components.host == "github.com" &&
            officialReleasePathPrefixes.contains { components.path.hasPrefix($0) } &&
            components.user == nil &&
            components.password == nil &&
            components.query == nil &&
            components.fragment == nil
    }

    func start() {
        guard !runtime.isActive else { return }
        clearPairingCode()
        status = .starting
        outputBuffer.removeAll(keepingCapacity: false)
        guard let resources = Bundle.main.resourceURL else {
            status = .failed("The connector resources are missing.")
            return
        }
        let nodeURL = resources.appendingPathComponent("runtime/node")
        let scriptURL = resources.appendingPathComponent("connector-runtime.cjs")

        var environment: [String: String] = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "LANG": Locale.current.identifier,
            "NODE_ENV": "production",
            "NO_COLOR": "1",
            "PATH": connectorSearchPath(),
        ]
        if let user = ProcessInfo.processInfo.environment["USER"] { environment["USER"] = user }
        if let tmpdir = ProcessInfo.processInfo.environment["TMPDIR"] { environment["TMPDIR"] = tmpdir }
        do {
            try runtime.start(
                executableURL: nodeURL,
                arguments: [scriptURL.path],
                currentDirectoryURL: FileManager.default.homeDirectoryForCurrentUser,
                environment: environment
            )
        } catch {
            status = .failed("The connector runtime could not be opened.")
        }
    }

    func stop() {
        clearPairingCode()
        send(["version": ipcVersion, "type": "shutdown"])
        runtime.stop()
    }

    func regenerateCode() {
        clearPairingCode()
        pendingDeviceName = nil
        pendingDeviceKeyFingerprint = nil
        pendingPairingId = nil
        allowSessionContent = false
        send(["version": ipcVersion, "type": "regenerate"])
    }

    func approve() {
        guard let pairingId = pendingPairingId else { return }
        send([
            "version": ipcVersion,
            "type": "approve",
            "pairingId": pairingId,
            "allowSessionContent": allowSessionContent,
        ])
    }

    func deny() {
        guard let pairingId = pendingPairingId else { return }
        send(["version": ipcVersion, "type": "deny", "pairingId": pairingId])
        pendingDeviceName = nil
        pendingDeviceKeyFingerprint = nil
        pendingPairingId = nil
        allowSessionContent = false
    }

    func updateDevice(
        _ device: ConnectorDevice,
        content: Bool? = nil,
        prompt: Bool? = nil,
        create: Bool? = nil
    ) {
        send([
            "version": ipcVersion,
            "type": "update_device",
            "deviceId": device.deviceId,
            "allowSessionContent": content ?? device.allowSessionContent,
            "allowSessionPrompt": prompt ?? device.allowSessionPrompt,
            "allowSessionCreate": create ?? device.allowSessionCreate,
        ])
    }

    func revokeDevice(_ device: ConnectorDevice) {
        send(["version": ipcVersion, "type": "revoke_device", "deviceId": device.deviceId])
    }

    func revokeDevices(_ devices: [ConnectorDevice]) {
        for device in devices {
            revokeDevice(device)
        }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            refreshLaunchAtLogin()
        } catch {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            status = .failed("Launch at login could not be updated.")
        }
    }

    func uninstall() {
        guard !uninstalling else { return }
        uninstalling = true
        protectedStateRemovalConfirmed = false
        status = .uninstalling
        if runtime.isRunning {
            send(["version": ipcVersion, "type": "reset"])
        } else {
            removeProtectedStateWithHelper()
        }
    }

    private func removeProtectedStateWithHelper() {
        guard uninstalling, !uninstallFallbackRunning else { return }
        guard let resources = Bundle.main.resourceURL else {
            uninstalling = false
            status = .failed("The connector resources are missing.")
            return
        }

        uninstallFallbackRunning = true
        let task = Process()
        task.executableURL = resources.appendingPathComponent("macos-keychain-helper")
        task.arguments = ["delete", keychainService, keychainAccount]
        task.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        task.terminationHandler = { [weak self] terminated in
            Task { @MainActor in
                guard let self else { return }
                self.uninstallFallbackRunning = false
                guard self.uninstalling else { return }
                guard terminated.terminationStatus == 0 else {
                    self.uninstalling = false
                    self.status = .failed("The connector could not remove its protected local data.")
                    return
                }
                self.protectedStateRemovalConfirmed = true
                self.finishUninstall()
            }
        }
        do {
            try task.run()
        } catch {
            uninstallFallbackRunning = false
            uninstalling = false
            status = .failed("The connector could not remove its protected local data.")
        }
    }

    private func refreshLaunchAtLogin() {
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    private func connectorSearchPath() -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ].joined(separator: ":")
    }

    private func consume(_ data: Data) {
        outputBuffer.append(data)
        if outputBuffer.count > maximumBufferedBytes {
            outputBuffer.removeAll(keepingCapacity: false)
            status = .failed("The connector returned an invalid response.")
            stop()
            return
        }
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer.prefix(upTo: newline)
            outputBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            do {
                let event = try JSONDecoder().decode(ConnectorEvent.self, from: Data(line))
                guard event.version == ipcVersion else {
                    status = .failed("The connector needs to be updated.")
                    continue
                }
                handle(event)
            } catch {
                status = .failed("The connector returned an invalid response.")
            }
        }
    }

    private func runtimeDidTerminate(_ terminationStatus: Int32) {
        clearPairingCode()
        pendingPairingId = nil
        pendingDeviceName = nil
        pendingDeviceKeyFingerprint = nil
        if uninstalling {
            if !protectedStateRemovalConfirmed {
                removeProtectedStateWithHelper()
            }
            return
        }
        if case .failed = status { return }
        status = .failed(terminationStatus == 0
            ? "The connector stopped."
            : "The connector could not start securely.")
    }

    private func handle(_ event: ConnectorEvent) {
        switch event.type {
        case "pairing_offer":
            clearPairingCode()
            guard let payload = event.payload,
                  let expiresAt = event.expiresAt,
                  expiresAt.isFinite,
                  expiresAt > Date().timeIntervalSince1970 * 1_000,
                  let image = ConnectorPairingCode.render(payload) else {
                status = .failed("The pairing code could not be rendered.")
                return
            }
            qrImage = image
            // The controller emits a fresh offer only after pending review ends.
            pendingPairingId = nil
            pendingDeviceName = nil
            pendingDeviceKeyFingerprint = nil
            allowSessionContent = false
            let expiry = Date(timeIntervalSince1970: expiresAt / 1_000)
            qrExpiresAt = expiry
            pairingCodeLifetime.receive(expiresAt: expiry)
            schedulePairingExpiry(expiry)
            if pendingPairingId == nil { status = .ready }
        case "ready":
            guard event.transport == "tailscale_vpn" else {
                status = .failed("This Connector version requires Tailscale.")
                return
            }
            transportLabel = "Tailscale connected"
            cliDetected = event.cliDetected ?? false
            sessionDiscoveryEnabled = event.sessionDiscoveryEnabled ?? false
            if pendingPairingId == nil { status = .ready }
        case "pairing_review":
            pendingPairingId = event.pairingId
            pendingDeviceName = event.deviceName
            pendingDeviceKeyFingerprint = event.deviceKeyFingerprint
            status = .awaitingApproval
        case "pairing_diagnostic":
            guard let route = event.route,
                  let phase = event.phase,
                  let responseStatus = event.status else { return }
            let action = route == "protected_request"
                ? "Protected request"
                : route == "pairing_submit" ? "Pairing request" : "Approval check"
            pairingDiagnostic = "\(action) · \(phase) · HTTP \(responseStatus)"
        case "pairing_complete":
            pendingPairingId = nil
            pendingDeviceName = nil
            pendingDeviceKeyFingerprint = nil
            allowSessionContent = false
            status = .paired
            regenerateCode()
        case "reset_complete":
            protectedStateRemovalConfirmed = true
            finishUninstall()
        case "devices":
            devices = (event.devices ?? []).sorted {
                if $0.pairedAt != $1.pairedAt { return $0.pairedAt > $1.pairedAt }
                return $0.deviceId > $1.deviceId
            }
        case "error":
            if event.code == "pairing_expired" {
                clearPairingCode()
                pendingPairingId = nil
                pendingDeviceName = nil
                pendingDeviceKeyFingerprint = nil
                allowSessionContent = false
                return
            }
            let message: String
            switch event.code {
            case "command_invalid": message = "The connector received an invalid local command."
            case "tailscale_unavailable": message = "Connect this Mac to Tailscale, then try again."
            case "unsupported_platform": message = "This connector build does not support this Mac."
            case "uninstall_failed": message = "The connector could not remove its protected local data."
            default: message = "The secure connector could not complete that action."
            }
            if event.code == "uninstall_failed" { uninstalling = false }
            if event.code == "tailscale_unavailable" { clearPairingCode() }
            status = .failed(message)
        default:
            status = .failed("The connector needs to be updated.")
        }
    }

    private func finishUninstall() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            uninstalling = false
            status = .failed("Launch at login could not be removed. Try uninstalling again.")
            return
        }

        NSWorkspace.shared.recycle([Bundle.main.bundleURL]) { _, error in
            Task { @MainActor in
                if error != nil {
                    self.uninstalling = false
                    self.status = .failed(
                        "Protected data was removed, but the app could not be moved to Trash. Quit and move it there manually."
                    )
                    return
                }
                NSApplication.shared.terminate(nil)
            }
        }
    }

    private func send(_ value: [String: Any]) {
        guard
            JSONSerialization.isValidJSONObject(value),
            let data = try? JSONSerialization.data(withJSONObject: value),
            data.count < 16_384
        else { return }
        var line = data
        line.append(0x0A)
        if !runtime.write(line) {
            status = .failed("The connector stopped responding.")
        }
    }

    private func clearPairingCode() {
        pairingExpiryTask?.cancel()
        pairingExpiryTask = nil
        pairingCodeLifetime.clear()
        qrImage = nil
        qrExpiresAt = nil
    }

    private func schedulePairingExpiry(_ expiry: Date) {
        pairingExpiryTask = Task { [weak self] in
            // Capped sleep also tolerates a corrupt runtime expiry without overflow.
            let delay = min(900, max(0, expiry.timeIntervalSinceNow))
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            catch { return }
            guard let self, !Task.isCancelled else { return }
            guard self.pairingCodeLifetime.consumeExpiry(now: Date()) else {
                self.schedulePairingExpiry(expiry)
                return
            }
            self.qrImage = nil
            self.qrExpiresAt = nil
            // The controller owns refresh and the separate approval lifetime.
            // This UI timer only hides stale offers if its event loop is delayed.
        }
    }
}

private struct StatusRow: View {
    let symbol: String
    let title: String
    let detail: String
    let available: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(available ? .green : .secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}

private struct ConnectorView: View {
    @ObservedObject var model: ConnectorModel
    @State private var showingOlderDevicesConfirmation = false

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Image(systemName: model.status.symbol)
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundStyle(statusColor)
                    Text("Otterin Connector")
                        .font(.system(size: 28, weight: .semibold))
                    Text(model.status.label)
                        .foregroundStyle(.secondary)
                }

                GroupBox {
                    VStack(spacing: 14) {
                        StatusRow(
                            symbol: "network",
                            title: "Tailscale",
                            detail: model.transportLabel,
                            available: model.status != .starting
                        )
                        Divider()
                        StatusRow(
                            symbol: "terminal",
                            title: "Devin for Terminal",
                            detail: model.cliDetected ? "Detected securely" : "Not detected — pairing only",
                            available: model.cliDetected
                        )
                    }
                    .padding(6)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Connector \(model.currentVersion)").font(.headline)
                            Spacer()
                            Button(model.isCheckingUpdate ? "Checking…" : "Check for updates") {
                                model.checkForUpdate()
                            }
                            .disabled(model.isCheckingUpdate)
                            .accessibilityLabel("Check for Otterin Connector updates")
                        }
                        if let message = model.updateCheckMessage {
                            Text(message).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(6)
                }

                if let update = model.availableUpdate {
                    GroupBox {
                        HStack(spacing: 12) {
                            Image(systemName: "arrow.down.circle.fill")
                                .foregroundStyle(.blue)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Update available").font(.headline)
                                Text("This update does not install automatically. Download the DMG, choose Quit Otterin Connector from the menu-bar menu, then drag Otterin Connector into Applications and choose Replace. Reopen Otterin Connector. Your pairing is kept.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text("Closing this window does not quit Connector. Updating the iPhone app does not update Connector.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text("\(update.tagName) is available from the official Otterin release page.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Download update") { model.openAvailableUpdate() }
                        }
                        .padding(6)
                    }
                }

                if let deviceName = model.pendingDeviceName {
                    GroupBox("Pairing request") {
                        VStack(alignment: .leading, spacing: 14) {
                            Label(deviceName, systemImage: "iphone")
                                .font(.headline)
                            if let fingerprint = model.pendingDeviceKeyFingerprint {
                                Text("Key fingerprint: \(fingerprint)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                            Text("Approve only if this is the device you are pairing and the key fingerprint matches.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            Toggle("Allow session titles and message history", isOn: $model.allowSessionContent)
                            Text("Message steering is a separate permission added after read-only pairing is validated.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            HStack {
                                Button("Deny", role: .destructive) { model.deny() }
                                Spacer()
                                Button("Approve device") { model.approve() }
                                    .buttonStyle(.borderedProminent)
                            }
                        }
                        .padding(6)
                    }
                } else if let qrImage = model.qrImage {
                    VStack(spacing: 12) {
                        Image(nsImage: qrImage)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 360, height: 360)
                            .accessibilityLabel("Otterin pairing QR code")
                        Text("In Otterin: Your computer → Pair a computer → Scan pairing code")
                            .font(.callout)
                            .multilineTextAlignment(.center)
                        Text("The code refreshes automatically and is valid only for this local device.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Generate new code") { model.regenerateCode() }
                    }
                }

                if let diagnostic = model.pairingDiagnostic {
                    Text(diagnostic)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                if !model.devices.isEmpty {
                    let activeDevices = model.devices.filter { $0.status == "active" }
                    let keep = activeDevices.first
                    let older = Array(activeDevices.dropFirst())

                    GroupBox("Paired devices") {
                        VStack(spacing: 0) {
                            if !older.isEmpty, let keep = keep {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack(alignment: .top, spacing: 8) {
                                        Image(systemName: "exclamationmark.triangle.fill")
                                            .foregroundStyle(.orange)
                                        Text("\(older.count) older device\(older.count == 1 ? "" : "s") can still connect to this Mac. Revoke any you no longer use.")
                                            .foregroundStyle(.secondary)
                                    }
                                    Button("Revoke older devices…", role: .destructive) {
                                        showingOlderDevicesConfirmation = true
                                    }
                                    .confirmationDialog(
                                        "Revoke \(older.count) older device\(older.count == 1 ? "" : "s")?",
                                        isPresented: $showingOlderDevicesConfirmation,
                                        titleVisibility: .visible
                                    ) {
                                        Button("Revoke \(older.count)", role: .destructive) {
                                            model.revokeDevices(older)
                                        }
                                        Button("Cancel", role: .cancel) {}
                                    } message: {
                                        Text("Only \(keep.deviceName), paired \(Date(timeIntervalSince1970: keep.pairedAt / 1_000).formatted(date: .abbreviated, time: .shortened)), stays connected. Revoked devices must pair again.")
                                    }
                                }
                                .padding(12)
                                Divider()
                            }
                            ForEach(model.devices) { device in
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        Label(device.deviceName, systemImage: "iphone")
                                            .font(.headline)
                                        Spacer()
                                        if device.id == keep?.id {
                                            Text("Most recent")
                                                .font(.caption)
                                                .foregroundStyle(.blue)
                                        }
                                        Text(device.status == "active" ? "Active" : "Revoked")
                                            .font(.caption)
                                            .foregroundStyle(device.status == "active" ? .green : .secondary)
                                    }
                                    Text("Paired \(Date(timeIntervalSince1970: device.pairedAt / 1_000).formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Toggle("Read session titles and history", isOn: Binding(
                                        get: { device.allowSessionContent },
                                        set: { model.updateDevice(device, content: $0) }
                                    ))
                                    .disabled(device.status != "active")
                                    Toggle("Send messages to sessions", isOn: Binding(
                                        get: { device.allowSessionPrompt },
                                        set: { model.updateDevice(device, prompt: $0) }
                                    ))
                                    .disabled(device.status != "active")
                                    Toggle("Create new sessions", isOn: Binding(
                                        get: { device.allowSessionCreate },
                                        set: { model.updateDevice(device, create: $0) }
                                    ))
                                    .disabled(device.status != "active")
                                    if device.status == "active" {
                                        Button("Revoke device", role: .destructive) {
                                            model.revokeDevice(device)
                                        }
                                    }
                                }
                                .padding(.vertical, 12)
                                if device.id != model.devices.last?.id { Divider() }
                            }
                        }
                        .padding(6)
                    }
                }

                if case let .failed(message) = model.status {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(message).foregroundStyle(.red)
                            Button("Try again") { model.start() }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                    }
                }

                Toggle("Open Otterin Connector when I log in", isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                ))
                .toggleStyle(.switch)

                Text("You can close this window. Otterin Connector keeps running from the menu bar until you choose Quit.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Text("Version \(model.currentVersion)")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)

                Button("Uninstall Otterin Connector", role: .destructive) {
                    model.showingUninstallConfirmation = true
                }
                .disabled(model.status == .uninstalling)
                .alert(
                    "Uninstall Otterin Connector?",
                    isPresented: $model.showingUninstallConfirmation
                ) {
                    Button("Cancel", role: .cancel) {}
                    Button("Uninstall", role: .destructive) { model.uninstall() }
                } message: {
                    Text(
                        "This removes the app, disables launch at login, and deletes this Mac’s Connector identity and paired-device permissions. Pairing must be completed again after reinstalling."
                    )
                }

                Text("Otterin is an independent, unofficial client and is not affiliated with Cognition AI.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(28)
        }
        .frame(minWidth: 520, minHeight: 700)
    }

    private var statusColor: Color {
        switch model.status {
        case .failed: return .red
        case .awaitingApproval: return .orange
        case .ready, .paired: return .green
        case .starting, .uninstalling: return .secondary
        }
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let model = ConnectorModel()
    private var window: NSWindow?
    private var statusItem: NSStatusItem?
    private var statusMenuItem: NSMenuItem?
    private var statusSubscription: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installStatusItem()
        showWindow()
    }

    func showWindow() {
        NSApplication.shared.setActivationPolicy(.regular)
        guard window == nil else {
            window?.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            return
        }
        let content = ConnectorView(model: model)
        let hostingController = NSHostingController(rootView: content)
        let window = NSWindow(contentViewController: hostingController)
        window.title = "Otterin Connector"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.styleMask.insert(.fullSizeContentView)
        window.setContentSize(NSSize(width: 560, height: 760))
        window.minSize = NSSize(width: 520, height: 700)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func windowWillClose(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        showWindow()
        return true
    }

    private func installStatusItem() {
        let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(
            systemSymbolName: "shippingbox.fill",
            accessibilityDescription: "Otterin Connector"
        )
        let menu = NSMenu()
        let statusMenuItem = NSMenuItem(title: model.status.label, action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        menu.addItem(
            withTitle: "Open Otterin Connector",
            action: #selector(openConnectorWindow),
            keyEquivalent: ""
        ).target = self
        menu.addItem(.separator())
        menu.addItem(
            withTitle: "Quit Otterin Connector",
            action: #selector(quitConnector),
            keyEquivalent: "q"
        ).target = self
        statusItem.menu = menu
        self.statusItem = statusItem
        self.statusMenuItem = statusMenuItem
        statusSubscription = model.$status.sink { [weak self] status in
            self?.statusMenuItem?.title = status.label
        }
    }

    @objc private func openConnectorWindow() {
        showWindow()
    }

    @objc private func quitConnector() {
        NSApplication.shared.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.stop()
    }
}

@main
private enum DevinXConnectorApplication {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = AppDelegate()
        application.delegate = delegate
        application.finishLaunching()
        delegate.showWindow()
        application.run()
    }
}
