# Fork divergence ledger — tourproapp/Otterin

Deltas from `upstream/main` (`fenner888/Otterin`). Each entry lists the
anchor, rationale, upstream tracking, and the removal criterion. Reconcile
on every upstream merge.

| # | Change | Anchor | Removal criterion |
|---|---|---|---|
| 1 | Session-DB schema v20 accepted in the review set (`live_row_times`) | `bridge/src/devin-session-store.ts` `REVIEWED_SCHEMA_VERSIONS` | Upstream accepts v20 (fenner888/Otterin#122) |
| 2 | ACP request timeout 5s → 30s — `initialize` alone exceeds 5s on multi-GB session databases, causing an abort/respawn loop | `bridge/src/acp.ts` `DEFAULT_REQUEST_TIMEOUT_MS` | Upstream raises default or makes it configurable |
| 3 | `authenticate {methodId: 'devin-browser'}` after `initialize` (non-fatal) — newer `devin acp` refuses `session/load`/`session/prompt` until the host authenticates | `bridge/src/acp.ts` `AcpSessionClient.start()` | Upstream authenticates |
| 4 | Connector update check repointed to `tourproapp/Otterin` releases — both `connectorReleaseApi` and the `isOfficialReleaseUrl` allowlist | `connector/macos/DevinXConnector.swift` | Permanent fork delta |
| 5 | `deviceKeyFingerprint` (truncated SAS) added to `pairing_review` + shown in the approval UI. Recipe: `sha256(devicePublicKeySpki DER)`, truncated base64url ~12 chars — same construction as `bridgeKeyFingerprint` (`pairing.ts` fingerprint helper). Spec-012 carve-out: the spec bans "fingerprints" in review summaries; this delta is deliberate — a truncated verification SAS lets the user detect a stolen-offer submit, which `deviceName` alone cannot (it is spoofable) | `bridge/src/pairing.ts`, `bridge/src/connector-ipc.ts`, `connector/macos/DevinXConnector.swift` | Permanent (unless upstream adds a verification UX) |
| 6 | `owner`/`ownerName` on `session.list`/`session.load` items — OPT-IN via `ownership: true` request flag (iOS response schemas are `.strict()`; unconditional fields would break every iOS client). Values: `free`, `locked_external`, `connector_live`; `ownerName` = best-effort lock-PID process name | `bridge/src/schemas.ts`, `bridge/src/service.ts`, `bridge/src/devin-session-store.ts`, `bridge/src/acp.ts` | Upstream adds an equivalent opt-in field |
| 7 | "Approve iPhone"/"Paired iPhones" strings → device-name-generic copy (paired devices are no longer only phones) | `connector/macos/DevinXConnector.swift` | Permanent |

## client-core copied-source baseline

`client-core/src/{canonicalJson,computerPairing,computerBridge,pairedComputers}.ts`
are copies of `src/auth/*` at upstream commit recorded in
`client-core/src/copy-source-sha.txt`, with RN/Expo imports replaced by
`ports.ts` facades (`deviceSigning.ts`, `keychain.ts`, `branding.ts`) and the
screenshot-fixture code excised. Upstream diffs to the source files must be
ported manually; the `tests/mac-client` oracle tests (real
`authorizeRequest` + `BridgeService`) are the divergence tripwire.

## Spec deviations (documented, deliberate)

- **Spec 012 §review summary** — patch 5 adds a truncated device-key SAS to
  the approval UX (see rationale above).
- **Spec 021 §offer channels** — no deviation: the Mac client consumes the
  Connector's rendered QR via screen capture or a user-created screenshot
  (optical path, same channel class as the iPhone camera). The payload is
  never written to clipboard, files, logs, or persistent state by either
  app.
