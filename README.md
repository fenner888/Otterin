<p align="center">
  <img alt="" src="assets/brand/icon-welcome.png" width="120">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark-transparent.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/wordmark-onlight.png">
    <img alt="Otterin" src="assets/brand/wordmark-onlight.png" width="280">
  </picture>
</p>

<p align="center"><strong>Local coding sessions, mobile. Start, follow and steer local Devin sessions on your Mac from your iPhone.</strong></p>

<p align="center">
  <a href="https://testflight.apple.com/join/KBD25apN"><strong>Join the TestFlight beta</strong></a>
  ·
  <a href="https://github.com/fenner888/Otterin/releases/latest"><strong>Download Otterin Connector</strong></a>
  ·
  <a href="docs/devinx-connector.md"><strong>Local setup guide</strong></a>
</p>

<p align="center">
  <a href="https://github.com/fenner888/Otterin/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fenner888/Otterin/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://testflight.apple.com/join/KBD25apN"><img alt="TestFlight Build 89" src="https://img.shields.io/badge/TestFlight-0.1.0%20(89)-0D96F6?logo=apple"></a>
</p>

> [!IMPORTANT]
> Otterin is an independent, unofficial client for Devin. It is not affiliated with, endorsed by,
> or a product of Cognition AI. Devin, Cognition, and third-party model names and marks belong to
> their respective owners. Otterin requires the user's own Devin for Terminal installation and
> account on a computer they control.

## Release status

| Product                          | Current release     | Availability                                                                                      |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| **Otterin for iPhone**           | `0.1.0 (82)`        | Testing in Team (Expo) and [Otterin Early Access](https://testflight.apple.com/join/KBD25apN)       |
| **Public App Store version**     | `1.0`               | Submitted to Apple and waiting for App Review · manual release after approval                     |
| **Otterin Connector for macOS**  | `0.1.18`            | [Signed and notarized Apple-silicon release](https://github.com/fenner888/Otterin/releases/latest) |
| **Otterin Connector for Windows** | `0.1.9.0` in certification; `0.1.10.0` next update | Windows 11 x64 compatibility update submitted to Microsoft; 0.1.10.0 shows Otterin Connector as the installed app name |

TestFlight access does not include a Devin account or shared Devin data. Each tester pairs a computer
they control that runs their own Devin for Terminal.

## What Otterin is

Otterin is a Local-only companion for Devin for Terminal sessions running on your own computer. It is
built for the moments when you are away from your desk but still need to start work, check progress,
answer a question, or review a result. Cloud sessions belong in Devin's official app.

- **Start work remotely.** Create Local sessions from the Home composer with the paired computer,
  workspace, and model you choose.
- **See recent sessions.** Search and browse recent Local sessions on each paired computer.
- **Keep work moving.** Read bounded history, follow live updates, send steering messages, and
  respond when a session needs input.
- **Use the real available catalog.** Workspaces and models come from the live local ACP
  catalog—not hardcoded guesses.
- **Speak detailed prompts.** On supported iOS 26 devices, dictation is transcribed on device. The
  optional **Organize prompt** preview uses Apple Foundation Models when available and falls back to
  deterministic on-device formatting.
- **Keep a helpful companion nearby.** The Otterin companion reflects session state without becoming
  an operating-system overlay or covering primary controls.

## How Otterin connects

Otterin talks only to Otterin Connector on a computer you pair. It needs Otterin, Tailscale,
supported local Devin ACP, and Otterin Connector. Pairing does not copy Devin credentials to the
iPhone; each paired iPhone has its own key, permissions, and revocation path.

```mermaid
flowchart LR
    I["Otterin on iPhone"] -->|"Tailscale + pinned TLS + signed requests"| X["Otterin Connector"]
    X -->|"Bounded ACP operations"| T["Devin for Terminal"]
```

Otterin operates no relay for Local session traffic.

## Install on iPhone

1. Install Apple's [TestFlight](https://apps.apple.com/app/testflight/id899247664) app.
2. Open the [Otterin Early Access link](https://testflight.apple.com/join/KBD25apN).
3. Install Build `0.1.0 (79)` and complete the in-app onboarding.
4. Pair your computer with Otterin Connector as described below.

## Install Otterin Connector

Connector is required: it is the only service Otterin connects to.

### Supported public release

- macOS 13 or later on Apple silicon
- [Tailscale](https://tailscale.com/download/mac) on the Mac and iPhone, signed into the same tailnet
- Devin for Terminal installed and authenticated on the Mac
- Otterin on the iPhone

### Setup

1. Download the signed DMG and checksum from the
   [latest official Otterin Connector release](https://github.com/fenner888/Otterin/releases/latest).
2. Verify the checksum published with that release.
3. Open the DMG and move **Otterin Connector** to Applications.
4. Open Connector and confirm it detects both Tailscale and Devin for Terminal.
5. In Otterin, open **Your computer → Scan pairing code**.
6. Scan the short-lived code and approve the named iPhone plus its requested permissions on the Mac.

The iPhone onboarding also includes a guarded assisted-setup prompt for an AI assistant on the Mac.
It uses only the official signed release, verifies the published checksum, and stops when a release
or trust check is unavailable. macOS still requires visible user approval; the iPhone app cannot and
does not silently install a desktop application.

For detailed installation, update, uninstall, development, and notarization information, read
[docs/devinx-connector.md](docs/devinx-connector.md).

### Windows 11 x64 public test track

The native per-user Windows application, DPAPI-protected state helper, notification-area lifecycle,
installer, deterministic uninstaller, pinned-runtime package, and automated Windows verification
are implemented. Windows 11 x64 is an active release target.

The Local runtime is supported by Cognition's official
[Windows Devin CLI installer](https://docs.devin.ai/cli/index) and documented
[`devin acp` subprocess](https://docs.devin.ai/cli/acp/zed). Connector still negotiates the
installed CLI's actual ACP methods at runtime and fails closed rather than inventing unsupported
controls. Cognition's separate
[Windows cloud-session environments](https://docs.devin.ai/onboard-devin/environment/windows-support)
are not the Connector runtime.

The unsigned EXE and ZIP artifacts produced by ordinary CI are deliberately marked **NOT FOR
RELEASE**. The Store-signed Windows 11 x64 package is publicly installable from the
[Microsoft Store listing](https://apps.microsoft.com/detail/9N52Z3FVMFH8) for controlled testing.
It is still a **public test track**, not a completed support claim, until the clean physical matrix
in [spec 037](specs/037-windows-connector.md) passes with the exact Store package. That matrix covers
official Devin ACP discovery, Tailscale routing, pairing, read/send/create grants,
AskUserQuestion, sleep/reconnect, update, and uninstall. Testers should follow the
[Windows Connector physical test checklist](docs/windows-connector-test-checklist.md) and must
never sideload the unsigned CI artifacts.

## Why Tailscale is not enough

Tailscale and Connector provide two separate required layers:

1. **Tailscale provides private network reachability** between the iPhone and Mac.
2. **Connector provides the trusted local service** that talks to Devin for Terminal, authenticates
   each iPhone, enforces its permissions, and returns bounded results.

A Tailscale IP, server URL, or shared password is not a Devin session service. Without compatible
software listening on the Mac, there is nothing for the phone to authenticate to or request sessions
from. Otterin uses short-lived QR pairing so every phone gets its own cryptographic identity,
permission set, and revocation path instead of sharing one reusable password.

## Local permissions and lifecycle

Connector grants are per iPhone and enforced on the Mac:

- **Read session titles and history**
- **Send messages to sessions**
- **Create new sessions**

The Mac owner chooses these permissions during pairing and can revoke a phone later. The iPhone can
request signed revocation while Connector is reachable. If the Mac is offline, Otterin offers an
honest local-only removal instead of claiming the Mac-side grant was revoked.

Closing the Connector window leaves its visible menu-bar service running. **Quit Otterin Connector**
stops it. Launch at login is an explicit user choice. Connector includes no root daemon, public
tunnel, analytics SDK, or silent updater.

## Security and privacy

- Otterin stores no Devin sign-in credentials. Paired-device keys stay in iOS Keychain with
  device-only protection.
- Local Devin credentials remain on the paired device and are never copied to the iPhone.
- Connector identity, TLS material, and paired-device grants stay in platform-protected storage.
- Every protected Connector request is authenticated, replay checked, rate limited, Zod validated,
  and authorized server-side. Unauthorized resource access receives a generic non-disclosing error.
- Local transport pins the Connector certificate and signs requests with a per-install iPhone
  key.
- Raw dictation audio is processed on device, is not uploaded by Otterin, and is not retained after
  transcription.
- Session content, transcripts, credentials, and QR payloads are excluded from analytics and logs.
- Disconnecting wipes credentials, protected caches, drafts, templates, and remembered session
  context from the iPhone.
- Version 1 ships no product-analytics, crash-reporting, or remote-push SDK.

Read the complete [Privacy Policy](PRIVACY.md), [Security Policy](SECURITY.md),
[Authorization Matrix](docs/authorization-matrix.md), and
[latest dependency audit](docs/dependency-audit-2026-07-15.md). Report vulnerabilities through
[GitHub's private vulnerability reporting](https://github.com/fenner888/Otterin/security/advisories/new),
never through a public issue containing sensitive details.

## Honest capability boundaries

Otterin exposes only behavior supported by an approved local ACP capability and the paired
iPhone's Connector grants.

- Devin Cloud sessions, organizations, and service users are out of scope; use Devin's official app
  or Devin Web for them.
- Local workspaces and models come from the live local catalog. Exact identifiers are preserved
  when dispatching work.
- Local tool approvals, arbitrary file access, arbitrary shell commands, public tunnels, and shared
  server passwords are outside the Connector grant model.
- Personal profile/OAuth settings, plan and invoice management, organization administration, and
  unsupported Web-only mutations remain owned by Devin Web.
- The initial mobile release is iPhone-only. Android and iPad are not supported. Connector `0.1.7`
  supports Apple-silicon Macs. Windows 11 x64 is an active release implementation whose public
  download activates only after its signature and physical compatibility gates pass; Linux and
  Intel Mac packages remain unavailable.

The Local-only product decision is in
[specs/041-local-only-otterin.md](specs/041-local-only-otterin.md).

## Development

### Requirements

- Node.js `24.18.0` (pinned in `.nvmrc` and `package.json`)
- Xcode and CocoaPods for native iOS builds
- macOS for Connector release checks
- Windows 11 x64 plus .NET 10 for Windows Connector verification
- A configured Expo/EAS development environment

```bash
git clone https://github.com/fenner888/Otterin.git Devinx
cd Devinx
npm ci --legacy-peer-deps
npm run ci
```

Native voice, camera, Keychain, certificate-pinning, and pairing modules require a native development
or TestFlight build. Expo Go is not the release test environment.

### Common commands

| Command                            | Purpose                                                |
| ---------------------------------- | ------------------------------------------------------ |
| `npm run start`                    | Start the Expo development server                      |
| `npm run ios`                      | Build and run the native iOS app                       |
| `npm run lint`                     | Run ESLint with zero warnings                          |
| `npm run typecheck`                | Run strict TypeScript validation                       |
| `npm run test`                     | Run the Jest suite serially with open-handle detection |
| `npm run build`                    | Validate app TypeScript and build the Connector bridge |
| `npm run audit`                    | Fail on high or critical dependency findings           |
| `npm run ci`                       | Run the complete repository CI gate                    |
| `npm run connector:build:macos`    | Build a local macOS Connector artifact                 |
| `npm run connector:verify:macos`   | Verify the packaged Connector artifact                 |
| `npm run connector:build:windows`  | Build the Windows x64 app, installer, and checksums    |
| `npm run connector:verify:windows` | Verify installer lifecycle, package, and DPAPI storage |
| `npm run connector:build:windows:store` | Build the exact-identity Microsoft Store MSIX      |
| `npm run connector:verify:windows:store` | Verify Store identity, manifest, assets, and MSIX  |

No package may be added until it is verified in the official registry, including its publication
history, download history, and source repository. Dependencies are lockfile-enforced; never use a
guessed package name.

## Architecture

```text
src/app/                 Expo Router screens
src/components/          UI and interaction components
src/api/bridge/          Connector client queries and presentation helpers
src/auth/                Keychain, pairing, signed Connector transport, and connection state
src/lib/                 Product rules, voice, polling, diagnostics, and utilities
modules/                 Reviewed native iOS modules
bridge/                  Authenticated local Connector service
connector/macos/         Native macOS application
connector/windows/       Native Windows application
connector/windows-installer/ Per-user Windows installer and uninstaller
specs/                   Product and security source of truth
docs/                    Setup, parity, threat-model, and release evidence
tests/                   Unit, integration, security, and UI contract tests
```

Start with the [Build Specification](specs/000-build-spec.md),
[Connector Guide](docs/devinx-connector.md),
[Authorization Matrix](docs/authorization-matrix.md), and [AGENTS.md](AGENTS.md).

## Contributing

The specification is the source of truth. Update the relevant spec before changing a supported
product or trust boundary. Contributions must preserve:

- server-side authorization for every protected route;
- Zod validation at every external input boundary;
- generic `404` non-disclosure for unauthorized resources;
- rate limits on authentication and write paths;
- Keychain or secure-store credential handling;
- no hardcoded secrets or auth tokens in browser storage;
- verified, lockfile-enforced dependencies; and
- dependency, secret, authorization/IDOR, dead-code, artifact, and physical-device release gates.

Before opening a pull request:

```bash
npm run ci
git diff --check
```

Use public issues for ordinary bugs and feature requests. Never include credentials, QR payloads,
private session content, repository secrets, or exploit details.

## Support

- [Open a bug or feature request](https://github.com/fenner888/Otterin/issues)
- [Report a vulnerability privately](https://github.com/fenner888/Otterin/security/advisories/new)
- [Read the privacy policy](PRIVACY.md)
- [View Otterin releases](https://github.com/fenner888/Otterin/releases)

## License and trademarks

Original Otterin software and documentation are available under the [MIT License](LICENSE). See
[NOTICE](NOTICE) for third-party dependencies, names, model-provider marks, screenshots, reference
material, and trademark boundaries.

The MIT License does not grant permission to use the Otterin name or branding as a trademark or to
imply affiliation with Cognition AI, Devin, or any model provider.
