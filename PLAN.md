# Otterin for Mac — build plan

A native-feeling macOS desktop client for the Otterin Connector bridge, living in
the `tourproapp/Otterin` fork. The Mac client pairs with the Connector on the
same machine as a second device — the same protocol the iPhone already uses —
so the phone and the desktop can both monitor and steer the same bridge-owned
Devin sessions. Local only; no Devin Cloud involvement.

Status: **v2 — revised after adversarial review** (4 critics: protocol,
architecture, security, UX scope). No implementation until this plan is final.

## 1. Constraints and invariants

- **One ACP host per session**, enforced inside the `devin` binary. A session
  owned by Devin.app's `devin acp` process returns `session_in_use`/`503` to any
  other host. Nothing client-side can remove this.
- **The bridge is the steering surface.** A single Connector-hosted
  `devin acp` process serves every paired device. Pending interactions are
  per-session, not per-device — any paired client can prompt, cancel, or answer
  elicitations/permissions on the shared process (see §5 multi-client rules).
- **Locked sessions are still useful.** `session.load` reads the sqlite store
  directly (no ownership needed), and `session.prompt` on a locked session runs
  a transparent continuation: a new session embedding a markdown transcript of
  the prior conversation plus the prompt. Locked = "monitor + fork-continue",
  never "steer in place".
- **Strictly request/response.** Three POST routes only, no SSE/WebSocket/push.
  All live UX is polling signed envelopes.
- **Spec 021, quoted exactly**: "The QR payload may cross only the inherited
  local IPC pipe and native render path. It must not enter stdout/stderr logs,
  files, crash reports, analytics, environment variables, command-line
  arguments, clipboard, browser history, notifications, or persistent
  application state." (`specs/021-devinx-connector.md:135`)
- **Same-UID honesty**: on macOS unsigned builds, neither Keychain items nor
  safeStorage blobs are a same-UID boundary — they protect against other
  users and casual file snooping, not a hostile local process. Document this;
  do not claim otherwise.
- **MIT fork.** `LICENSE` + `NOTICE` verbatim; disclaimers preserved.
- Fork deltas are tracked in `docs/compat.md` (divergence ledger — created in
  this work; it does not exist yet) with a removal criterion per patch, the
  upstream SHA the client-core files were copied from, and a link to
  fenner888/Otterin#122.

## 2. Repo layout (no npm workspaces)

Matches the repo's convention: subprojects sharing root `node_modules`
compiled via per-dir tsconfigs (`bridge/`), plus leaf apps with their own
lockfiles (connectors). Electron stays out of the Expo dependency graph.

```
client-core/                 # plain TS dir, NO package.json (mirrors bridge/)
  src/
    canonicalJson.ts         # verbatim copy from src/auth/
    computerPairing.ts       # offer parse, HMAC proof, poll loop, receipt
                             # verify, endpoint-migration re-pair, revoked-
                             # credential re-pair (computerPairing.ts:332-383)
    computerBridge.ts        # protocol core minus fixture code (~258 lines,
                             # computerBridge.ts:1198-1455) and fixture guards
    pairedComputers.ts       # credential schemas + registry logic minus
                             # @lib/branding, ./keychain, ./screenshotFixtures
    ports.ts                 # DeviceCrypto + Transport interfaces +
                             # keyed-secret blob accessor; ALSO provides the
                             # ./deviceSigning-compatible facade the copies
                             # import (named explicitly to avoid the rename
                             # trap)
    copy-source-sha.txt      # upstream commit these files were copied from
mac-client/                  # own package.json + package-lock.json
  src/
    main/                    # ALL bridge I/O, keys, pairing — main only
      index.ts               # lifecycle, single-instance, argv hygiene,
                             # BrowserWindow; lazy require('electron') at
                             # module scope for jest compatibility
      crypto.node.ts         # DeviceCrypto: node:crypto Ed25519 + random +
                             # hmac (createHmac over DECODED secret bytes)
      transport.node.ts      # node:http request impl (NOT fetch — see §3.1)
      secrets.mac.ts         # single safeStorage-encrypted blob:
                             # {deviceKeyId, privateKeyPkcs8, registry}
      ipc.ts                 # zod-validated ipcMain.handle + sender pinning
      pairing-capture.ts     # desktopCapturer + QR decode (jsQR)
      scheduler.ts           # main-process poll scheduler (visibility +
                             # background-cadence aware)
    preload/index.ts         # invoke-only contextBridge (CJS — sandboxed)
    renderer/                # React + Vite + Tailwind (fresh, not RN-ported)
    assets/, electron-builder.yml
tests/mac-client/            # root jest already testMatches tests/**;
                             # electron-only modules stubbed/lazy-required
docs/compat.md               # divergence ledger
```

**Extraction strategy (v1): copy, do not rewire.** `client-core` files are
copied from `src/auth/*` with RN imports deleted and port interfaces added.
`src/auth` and the iPhone app are untouched — zero blast radius. Copied files
also carry over the non-RN logic in `queries.ts`/`presentation.ts`/
`computer-model-catalog.ts` that must be ported, not dropped: bounded
`session.list` pagination (≤5 pages/computer, cursor-mismatch →
`invalid_response`), grant presentation mapping, the error→copy tables
(`publicErrorMessage`/`promptErrorMessage`/`discoveryErrorCopy`), model
family/variant grouping, `requestWithInteractionFallback`/`presentation` gates,
and `messageTimeLabels`/`formatRelativeTime`. **Device-noun pass**: copied
error strings hardcode "This iPhone" — all strings need a device-name sweep.

Copy realism (from the import audit): `canonicalJson.ts` and
`computerPairing.ts` are verbatim/near-verbatim (zero RN imports);
`pairedComputers.ts` needs 3 deletions; `computerBridge.ts` needs the fixture
block + ~10 guards + `@theme/tokens` removed; `deviceSigning.ts` is a **rewrite
facade** over the ports (its real work is a native module on iOS).

Ed25519 interop is verified: Node `generateKeyPair('ed25519')` exports SPKI DER
identical to the iOS module's RFC 8410 encoding (44 B → base64url 59);
`crypto.sign(null, msg, pkcs8)` → same 64 B sig → base64url 86; the bridge
verifies exactly that (`bridge/src/security.ts:93-110`).

## 3. Protocol — the contract the client implements

### 3.1 Transport rules the listener enforces

- POST only: `/v1/request`, `/v1/pair/submit`, `/v1/pair/status`. All else → 404.
- Exactly one `Host` header = `advertisedHost:advertisedPort`, port explicit.
  Connect to the offer's IP literal, not MagicDNS.
- Exactly one `Content-Type` = `application/json` (`; charset=utf-8` optional);
  exactly one digit `Content-Length`, 1..256 KiB, matching bytes; UTF-8.
- Forbidden → 404: `Origin`, `Cookie`, `Authorization`, `Proxy-Authorization`,
  `Sec-Fetch-Site`. `Content-Encoding` → 415, `Transfer-Encoding` → 400.
- Limits: ≤32 headers/16 KiB; 120 req/min per peer IP; ≤4 concurrent/peer,
  16 global; pairing submit 10/min, status 120/min.
- `tailscale_wireguard` = plain HTTP, peer IP in `100.64.0.0/10` or
  `fd7a:115c:a1e0::/48`. Connector always runs this mode. `pinned_tls` exists
  only for the standalone CLI — v1 client refuses non-tailnet credentials at
  open and ships no pinned transport code (dead surface).
- **Same-Mac reachability — verified correctly this time**:
  `POST /v1/request` to `http://100.122.39.119:45831` with body `{}` →
  `400 invalid_request`. The peer check runs before method/schema checks
  (`listener.ts:407-408`), so a 400 proves the hairpin connection presents a
  valid tailnet-range source address. Same-machine pairing works.

`node:http` foot-guns for `transport.node.ts`: always set `Content-Length`
explicitly (omission → chunked → 400); server `keepAliveTimeout=5s`,
`maxRequestsPerSocket=100`, `requestTimeout=15s` (< our 20s client timeout —
the server can cut first; see retry rules), `maximumConnections=32`.

### 3.2 Signed envelope

`POST /v1/request`, strict, exactly 10 keys:

```
{ protocolVersion: 2, bridgeId, deviceId, requestId, issuedAt, expiresAt,
  nonce, method, body, signature }
```

- `requestId` UUID; `nonce` 24 random bytes → base64url 32; `body` required
  even when `{}`; `signature` Ed25519 64 B → base64url 86.
- Signed bytes: `canonicalJson` of the other 9 fields (recursive key-sorted,
  no whitespace; `bridge/src/canonical.ts` ≡ `src/auth/canonicalJson.ts`).
- Timing — **ms epoch**: `expiresAt - issuedAt` ∈ (0, 30s], `issuedAt ≤
  now+5s` (one-directional skew — stale issuedAt is fine), `expiresAt > now`.
  Client lifetime 15s.
- Replay: `(deviceId, nonce)` consumed once until `expiresAt` — and the nonce
  is burned **before** body validation (`security.ts:174`), so a malformed
  body still consumes it. Every retry mints fresh nonce + requestId +
  signature; never resend a signed envelope.
- Failure map: 400 bad schema; **404 for all auth/authz/replay failures**
  (indistinguishable by design); 409 conflict/auto_approve_unavailable;
  429 rate_limited/busy; 503 unavailable.

### 3.3 Pairing ceremony

1. **Offer** — `{protocolVersion:2, bridgeId, bridgePublicKeySpki(59),
   bridgeKeyFingerprint(43), transportSecurity, bridgeEndpoint,
   tlsCertificateFingerprint(43), pairingId, pairingSecret(43), expiresAt,
   computerName?}`; ~120 s TTL, rotated continuously (up to 5 outstanding,
   each individually valid). Verify
   `bridgeKeyFingerprint = base64url(sha256(spki-der))`.
2. **Submit** — POST `/v1/pair/submit` with **exactly these fields**:
   `protocolVersion, bridgeId, pairingId, bridgeKeyFingerprint,
   transportSecurity, bridgeEndpoint, tlsCertificateFingerprint` (the 7 echoed
   offer fields — NOT bridgePublicKeySpki/pairingSecret/expiresAt/
   computerName; extras → 400 strict schema), plus `deviceId`,
   `deviceName`(≤80, no ctrl), `devicePublicKeySpki`, and
   `proof` = base64url(HMAC-SHA256(key=DECODED-32-byte-pairingSecret,
   canonicalJson(unsigned request))). → `202 {status:'pending', pollToken(43),
   expiresAt}` (300 s approval window).
   **Offer fragility**: every schema-valid submit consumes the offer (single-
   use); echoed-field mismatch or bad spki also deletes it; 3 bad proofs kill
   it. Two clients pairing concurrently need different live offers.
3. **Poll** — POST `/v1/pair/status` `{protocolVersion, bridgeId, pairingId,
   pollToken}` ≤ every 2 s → `202 {status:'pending', expiresAt}` (value must
   stay consistent) → `200 {status:'approved', receipt}` — delivered **once**;
   if lost, the device is registered but the client has no credentials →
   re-pair (new deviceId); 404 = denied/expired. Tolerate transient transport
   errors within the expiry window (deliberate deviation from the iOS
   fatal-on-anything loop — connector restart mid-approval should not kill
   the ceremony).
4. **Receipt** — verify Ed25519 sig over `canonicalJson(receipt−signature)`
   with `bridgePublicKeySpki`, all echoed fields + deviceId match; persist
   derived `pairedComputerCredentialSchema` record.
5. Grants at approval: `bridge:health` + `session:metadata:read`, plus
   `session:content:read` if the approval dialog's content toggle is on.
   `session:prompt:send`/`session:create` are post-pairing Connector toggles
   only — discovered via `bridge.features{presentation:true}` → `grants`.
6. Re-pairing an already-paired bridge follows the **endpoint-migration**
   path (refreshes endpoint when the Tailscale IP changes); revoked
   credentials → delete identity + fresh pair. Both flows must be ported.

### 3.4 Methods (minimum viable set marked ✓)

| Method | Grant | Notes |
|---|---|---|
| ✓ `bridge.health` | bridge:health | caps + readiness; `capabilities.sessionList=false` ⇒ Devin CLI/ACP unauthenticated — surface it |
| ✓ `bridge.features` | bridge:health | `interaction`/`presentation` request flags gate optional response fields; per-method 10/min bucket — cache ≥60s |
| ✓ `session.list` | metadata:read | `interaction:true` gates `awaiting` only — row `activity` is always emitted (locked detection needs no flag); cursor pages ≤5; `local_` handles; title needs content:read. 30/min first page, 120/min continuation, global single-flight → `429 busy` |
| ✓ `session.load` | content:read | one-shot transcript (sqlite → turn snapshot → ACP load+release); `interaction`+`timestamps` flags; 30/min, single-flight. **During a prompt this still succeeds** via sqlite/snapshot — 429 busy only against another load |
| ✓ `session.activity` | content:read | THE live channel; `turn` only for bridge-owned turns and **persists after end** — live = `active && turn`, not `turn` alone. 180/min (own bucket — elicitation/permission each have their own too) |
| ✓ `session.prompt` | prompt:send | returns on dispatch, not turn end (server requestTimeout 15s can cut the HTTP response — reconcile via list/activity before retrying or you double-prompt); response `sessionId` ≠ request = transparent continuation → navigate. 10/min |
| ✓ `session.cancel` | prompt:send | any device cancels the one bridge-owned turn; 409 if none |
| `session.elicitation` + `.respond` | content:read / prompt:send | forms on bridge-owned turns; all field types incl. allowOther; actions accept/decline/cancel; all respond failures → 404 |
| `session.permission` + `.respond` | content:read / prompt:send | 10-min auto-cancel; decisions `allow_once/allow_session/reject_once` |
| `session.create_options` + `session.create` | metadata:read / create | create+first-prompt atomic; busy → **503** (not 409 — `AcpBusyError` falls to generic); text ≤10 000 vs prompt ≤100 000; `defaultModelId` must parse or tolerate catalog quirks |
| `device.revoke` | bridge:health | revokes the CALLING device only |
| `bridge.platform` / `bridge.version` | bridge:health | fork-Connector version gating |

Handles `local_/workspace_/interaction_/permission_`+43 base64url: HMAC'd,
in-memory, ~24 h TTL, die on Connector restart → 404 → rehydrate via
`session.list`/`create_options` once.

Client must send `interaction:true`/`presentation:true` **only** when
`bridge.features` advertises support — older Connectors 400 on unknown fields;
port the iOS `requestWithInteractionFallback` gate.

## 4. Session semantics that shape the UX

- **Messages** are flat `{sequence, source:'user'|'devin', text, createdAt?}`;
  thoughts/tools live in `activity[]` entries `{id, afterSequence,
  kind:'thought'|'tool', toolKind?, status, title, paths?, detail?,
  truncated, startedAt?, endedAt?}` — `awaiting_input`/`timed_out` statuses
  only with `interaction:true`. `updatedAt` is ISO string on list rows, ms
  int in activity — normalize.
- **Locked-vs-free is already derivable today** without any bridge change:
  `activity` present-but-`active:false` ⇒ locked-idle (lock PID alive);
  `activity` absent ⇒ free. What patch 6 adds is splitting *live-external*
  from *live-bridge* turns (both are `active:true` today).
- **Mid-turn**: `activity.turn.reply` accumulates agent text for bridge-owned
  turns (incremental render via 1–1.5 s polling); externally-started turns
  have no `turn` — render committed DB state honestly, never fake streaming.
- **Turn end**: `active:false` + `label:'Response ready'`, or the iPhone rule
  (devin-reply signature identical across two loads).
- **Busy taxonomy (corrected)**: prompt during live turn → 409; create during
  busy → 503; load during prompt → succeeds; load vs load → 429 busy;
  `session_in_use` with no continuation path → 503.
- Activity labels ("Response ready", "Waiting for your approval",
  "Waiting for your answer in Terminal") are bridge vocabulary via
  `awaiting` mapping — distinct from `statusLabels` tokens; keep both
  vocabularies straight in the port.

## 5. Multi-client semantics — the "seamless" contract

The product premise is two clients on one bridge. These are the bridge's
actual concurrency semantics; the client's UX must be honest about each:

- **One bridge-owned turn, globally.** `activePromptSessionId` is a single
  slot — a prompt from the Mac while the iPhone has ANY session mid-turn →
  `409 conflict` (cross-session AND cross-device). Copy: "The connector is
  busy with another turn" — not "Devin is finishing the previous turn".
- **`session.cancel` is shared**: either device can stop the bridge-owned
  turn — a genuine seamless win.
- **Pending interactions are first-responder-wins.** One pending
  elicitation/permission per session; whichever device responds first wins;
  the loser's next poll returns `null` and its card must retire (no distinct
  "answered elsewhere" signal exists — the dock simply disappears on the
  next poll; this is expected, not an error).
- **Single-flight list/load are process-global** — a Mac `session.load` can
  collide with an iPhone's → `429 busy` is routine; one short retry, no
  escalation.
- **Auto-approve is last-prompter-wins** and persists per session —
  silently reverting the other client's setting. The mode is write-only
  (no method reads it back), so the composer toggle means "apply
  auto-approve to this client's next prompt" — stated in the UI copy, not
  presented as the session's current mode.
- **Continuation `sessionId` goes only to the prompter** — the other client
  sees the locked original plus an unlinked new session on the next list.
  Accepted v1 limitation; note it in docs (a `continuedFrom` field is a
  possible later fork delta).
- **Rate budgets**: per-method buckets are per-device (prompt 10/min,
  cancel 10/min, features 10/min, create_options 10/min — all independent);
  transport caps (120/min, 4 concurrent) are per-IP, so the two clients do
  not split budgets — except the aggregate 120/min applies per peer,
  leaving thin headroom at fast cadences (≈80-90/min for one live
  session). Keep ≤2 in flight per client.

## 6. Update model (polling design)

| Surface | Cadence | Method |
|---|---|---|
| Session list | 30 s foreground / 15 s "fast" | `session.list interaction:true` |
| Background (window hidden/closed-to-tray) | 30 s list only | drives Dock badge + notifications for `awaiting` |
| Open session, idle | 3 s | `session.activity` only |
| Bridge-owned turn | 1–1.5 s `activity` + 3 s `load` until reply signature settles | renders `turn.reply` live |
| External turn | 2–3 s `activity` + 3–5 s `load` | committed-state render only |
| Awaiting input | `elicitation`/`permission` only while `awaiting` set | each has own 180/min bucket |
| `bridge.features` | ≥60 s cache | own 10/min bucket |

**Back-off (corrected)**: `429 busy` → one retry ~400 ms, then normal cadence.
`429 rate_limited` → double interval to 30 s ceiling + jitter.
**503 is dual-purpose**: on a mutation during a known-live turn it means busy
(bounded 2–5 s retry); on `bridge.health`/list sustained ≥3 consecutive →
offline banner. The ACP child respawns after every bridge-owned turn
(~1–5 s window where everything 503s) — brief retries must tolerate this
without bannering; a single 503 never shows "offline".
`404` on a session → rehydrate handles once. Poll scheduler lives in **main**
(process-global rate budget, window-visibility aware, background 30 s
list-only for badge/notifications — do not rely on renderer timers, which
Chromium throttles anyway).

## 7. UX

Electron app, React+Vite+Tailwind renderer, dark-first using `tokens.ts`
palette/vocabulary verbatim (`statusLabels` exact strings). Window 960×600
min, `hiddenInset` titlebar, vibrancy sidebar. Product name: **Otterin**
(user's call — same name as the iOS app; the device name sent at pairing is
`Otterin (Mac)` so Connector device lists stay distinguishable).
Multi-computer support is in scope: the registry holds up to 8 computers —
the same pairing flow works against Connectors on OTHER machines over the
tailnet (remote QR via screenshot-share → file-drop path). Polling-mode
setting (battery/balanced/fast) for parity.

- **Sidebar**: search, "+ New session", rows (status dot, title/workspace,
  model, relative time, activity label), grouped "Live in Otterin" →
  "Waiting for you" → "Open in Devin" → "Recent". Footer: connector health
  + grants popover (view/prompt/create).
- **Transcript**: user bubbles right; devin text markdown (**sanitized** —
  agent output is untrusted: no raw HTML/`rehype-raw`); activity groups
  collapsed under `afterSequence` boundaries; live turn expanded at bottom;
  `truncated` banner; timestamps (`timestamps:true`, day separators +
  relative times); auto-scroll pinned.
- **Session states** (three tiers, honest attribution):
  *Free* — full composer.
  *Live via Connector* — `active && turn`; Stop button; interaction dock.
  *Open in another Devin client* — locked (see detection below): monitor +
  fork-continue. Chip copy "Open in another Devin client on this Mac" —
  do NOT claim "Devin.app" (a lock can be the CLI TUI); `ownerName` from
  patch 6 sharpens it best-effort. Explainer: *"Devin allows one driver at a
  time. Read the live history here, close it in the other app to take over,
  or continue the work in a new session."* Primary: **Continue in a new
  session** — sends the user's drafted prompt via `session.prompt` on the
  locked session (the fork path is prompt-driven, not a bare button) →
  navigate to the returned `sessionId` + "Continued in a new session" info
  bar. Optional secondary: "Open Devin" (`open -a Devin` — app-level only;
  **no per-session deep link exists**). Note the symmetric wall in docs:
  Devin.app also can't open bridge-owned sessions — they appear in its
  sidebar and error on open.
- **Interaction dock** (elicitation > permission priority): permission card
  (command, paths, decisions, countdown to expiresAt — new affordance, not
  parity), elicitation forms (all field types + allowOther + decline/cancel),
  terminal-question card (read-only: "Answer in Terminal on this Mac"),
  answered-summary rows, stale-card retirement when the other device answers
  (§5). Notification + **Dock badge** (tray = icon-state swap, not a numeric
  badge) on pending approvals when unfocused — notification bodies stay
  generic (no session content).
- **Composer**: `Cmd+Return` send (Enter=newline); optimistic bubble;
  disabled on live turn (cross-session busy copy above), terminal question,
  or missing `prompt:send` grant (read-only bar + popover); char limits
  per-path (10 000 create / 100 000 prompt).
- **New session** (`Cmd+N`): workspace picker (search, dedup'd
  `workspaceName`s), model picker (families/variants/recommended/cost/recent
  from `create_options`, `catalogSource:'recent'` staleness warning +
  refresh), auto-approve toggle, first-prompt composer, navigate straight to
  live turn.
- **Onboarding** (full checklist): app runs → checks Connector reachable
  (`open -a "Otterin Connector"` affordance if not — same-machine win) →
  Tailscale running + signed in (Connector fails without a `100.x` address) →
  Devin CLI present + authenticated (`health.capabilities` signal: list
  works but load/prompt 503 when unauthenticated — surface "sign in to
  Devin") → `sessions.db` present (continuation/monitoring depend on it —
  warn, don't discover) → **pairing (§8)** → approval dialog content toggle
  explained → grant enablement step ("enable Send prompts + Start sessions
  for this device in Otterin Connector") → fork-Connector version gate
  (`bridge.version` ≥ fork build — "update your Connector" state when the
  pairing affordance isn't there).
- **Settings**: paired-computer list, unpair/`device.revoke`, revoked-device
  re-pair state (`authorization_failed` → "pair again"), discovery-state
  notices (`session_discovery_off`, `authorization_failed`, `busy`,
  `invalid_response`, `too_many_sessions`), metadata-only degraded mode
  (no content grant → no titles/history, "Session title hidden").
- **Shortcuts**: `Cmd+N`, `Cmd+Return`, `Cmd+F`, `Cmd+K`, `Cmd+W`
  close-to-tray, `Cmd+1…9` jump.

## 8. Pairing UX + security model

### Offer handoff — spec-021-clean, zero new Connector surface

The Connector already renders the offer as a QR. The Mac client uses the
desktop equivalent of the iPhone camera channel:

- **Primary**: screen capture → jsQR decode of the Connector's visible QR.
  Implementation caveats (verified): Electron `desktopCapturer`
  window-source thumbnails are nondeterministically empty on ≥29.1 and
  default 150×150 — must capture a **full-screen source at real size** or
  `getDisplayMedia` frames. Screen Recording TCC grants work unsigned but
  are **per-build** for adhoc binaries (new cdhash → re-prompt per
  rebuild; "one-time" holds per binary only).
- **QR-visibility precondition**: the Connector is a menu-bar app — its
  window can be closed (no QR to capture), and during a pending review the
  QR is replaced by the approval dialog while offer refresh pauses. The
  capture flow must sequence: capture fails/no QR decoded →
  `open -a "Otterin Connector"` (fires `applicationShouldHandleReopen` →
  shows window) → retry → still none → instruct user to open the Connector
  pairing view.
- **Fallback**: user screenshots the QR (`Cmd+Shift+4`) and drops/selects
  the PNG in the app — zero permissions. Note: the PNG holds a live
  `pairingSecret` until ~120 s TTL/consumption — the app offers
  import-and-delete and notes expiry.
- **Not chosen**: selectable-text + user copy (literal spec-021 clipboard
  violation + pasteboard-scraper race); unix socket (a third channel needing
  spec amendment, plus the same race); clipboard write by app (forbidden).
- The payload must transit as a one-shot value → submit → zero; never
  persist in renderer state or logs (spec 021 "persistent application
  state").

### Patch 5 — SAS fingerprint in approval (fixes the blind-approval race)

`pairing_review` today carries only a spoofable `deviceName` — raceable on
every channel, including iPhone pairing. Fork delta:

- `bridge/src/pairing.ts`: include `deviceKeyFingerprint` in the
  `pairing_review` IPC event — **recipe pinned in compat.md**:
  `sha256(devicePublicKeySpki DER bytes)`, truncated base64url ~12 chars,
  matching `bridgeKeyFingerprint` construction at `pairing.ts:442-444`
  (hash over DER, not over the base64url string). Spec-012 carve-out
  documented: a truncated verification SAS is not key material (spec
  012:32 bans "fingerprints" in review summaries — the delta is
  deliberate and recorded).
- `DevinXConnector.swift`: display the fingerprint in the approval dialog.
- Mac client: shows its own key fingerprint on the pairing screen before
  submit; user approves only on match. iPhone gains the same protection
  free. Client warns when a submit 404s on a fresh offer ("offer consumed —
  deny the pending request if it isn't yours").

### Key + credential storage (unsigned-v1 correct choice)

- **safeStorage-encrypted single blob** in `userData` (0600 belt-and-braces)
  holding `{deviceKeyId, privateKeyPkcs8, pairedComputers[]}` — encryption
  key lives in the app's own Keychain item (`<productName> Safe Storage`),
  which third-party binaries cannot invoke without a user prompt;
  `RunAsNode` fuse off removes the "run JS inside the trusted binary"
  bypass. Caveats handled: call safeStorage only after the first
  BrowserWindow is ready (earlier use can bind the shared "Chromium Safe
  Storage" item — Electron #34614); gate on `isEncryptionAvailable()`;
  decrypt-failure → "credentials unreadable, pair again" path; unsigned
  rebuilds may re-prompt for keychain access (documented dev friction).
- **Rejected for unsigned v1**: the `macos-keychain-helper` binary — any
  same-UID process can exec `helper get` and exfiltrate the key (ACL trusts
  the binary, not the caller); and it returns raw PKCS8 to Node anyway, so
  the "key never leaves native" ideal doesn't survive either way.
- **Honest invariant**: key bytes never leave the main process — never
  reach the renderer, IPC payloads, JS logs, or disk in plaintext.
  (Signed-build upgrade path later: extend the helper with sign ops so key
  material never enters Node.)
- Renderer sees only `PairedComputerSummary` (bridgeId, computerName,
  pairedAt, permissions, transportKind) — no endpoint, fingerprints, or key
  ids over IPC.

### Electron hardening

- `contextIsolation`, `sandbox`, `nodeIntegration:false`, `webSecurity`,
  CSP `default-src 'self'; connect-src 'self'` (renderer never touches the
  bridge), deny `windowOpen`/`will-navigate`/permission handlers,
  `webviewTag` off.
- IPC: invoke-only preload; every payload zod-validated in main; handlers
  pinned to `event.senderFrame`/own `webContents`.
- Fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
  `EnableNodeCliInspectArguments` off (both are main-process injection
  vectors for key material), `EnableCookieEncryption` on. Do NOT claim
  asar-integrity — it cannot function unsigned.
- Argv hygiene at boot: refuse `--inspect*`/`--remote-debugging-port`/v8
  flags; single-instance lock; ignore second-instance argv.
- `crashReporter` not enabled (spec bans payload in crash reports; minidumps
  capture in-memory key material).
- Never logged/persisted: private key, pairingSecret, pollToken, offer
  payload, signatures, session content, endpoint. Audit logs only. No
  session-content cache at rest; drafts/prefs only.
- `appId`/`productName` set before first notification (attribution); dev
  `electron` binary attribution noted.

## 9. Fork deltas (`docs/compat.md` ledger)

| # | Change | File(s) | Removal criterion |
|---|---|---|---|
| 1 | schema v20 in review set | `bridge/src/devin-session-store.ts` | upstream accepts v20 (#122) |
| 2 | ACP timeout 5s→30s | `bridge/src/acp.ts` | upstream raises/configures |
| 3 | `authenticate devin-browser` post-init | `bridge/src/acp.ts` | upstream authenticates |
| 4 | Update check repoint: `connectorReleaseApi` AND `isOfficialReleaseUrl` allowlist → `tourproapp/Otterin` (both sites — `DevinXConnector.swift:11` + `:198-203`) | `connector/macos/DevinXConnector.swift` | permanent fork delta |
| 5 | `deviceKeyFingerprint` (truncated SAS, sha256-over-DER) in `pairing_review` event + approval UI display — Swift `ConnectorEvent` is all-optional Decodable so old Connectors ignore the field | `bridge/src/pairing.ts`, `connector-ipc.ts`, `DevinXConnector.swift` | permanent (spec-012 carve-out) |
| 6 | `owner` field on session.list/load items — **opt-in via `ownership: true` request flag** (iOS strict schemas break on new fields otherwise), `.optional()` client-side; values `free\|locked_external\|connector_live` + best-effort `ownerName` (lock PID → `ps -o comm`); needs `getSessionLiveness` to surface lock PID + ACP child PID | `bridge/src/service.ts`, schemas, `devin-session-store.ts`, `acp.ts` | upstream adds equivalent |
| 7 | "Approve iPhone"/"Paired iPhones" → device-name strings | `DevinXConnector.swift` | permanent |

Patches 1–3 committed on `mac-client`. Patch 4 prevents the Connector
self-updating into a build that silently reintroduces all three
incompatibilities. compat.md also records the upstream SHA of copied
client-core files (merge-drift tripwire: upstream diffs to those files need
manual porting).

## 10. Build milestones → parallel work slices

1. **`client-core` extraction + Node ports** — copies, `ports.ts` facade,
   `crypto.node.ts`, `transport.node.ts`, `secrets.mac.ts` (safeStorage
   blob), ported non-RN logic from queries/presentation/model-catalog;
   unit tests vs `authorizeRequest` oracle. **Device-noun pass included.**
2. **Connector patches 4+5+7** — Swift: update-repoint (both URL sites),
   pairing-review SAS field + display, device-name strings.
3. **Bridge patch 6** — `ownership: true` opt-in flag → `owner`/`ownerName`
   on list/load rows; liveness surfaces lock PID; ACP child PID exposed;
   schema + tests.
4. **Electron shell + pairing** — main/preload/IPC skeleton, QR capture +
   jsQR, pairing flow incl. re-pair/migration paths, safeStorage store,
   poll scheduler. **Acceptance: unsigned `--dir` packaging smoke test NOW**
   (safeStorage + spawn-free crypto are the risk surface — don't defer to
   packaging milestone) + pair → `bridge.health` → `session.list` render.
5. **Session view** — transcript renderer (sanitized markdown), activity
   loop, composer, prompt/cancel, continuation navigation + info bar,
   locked-session explainer + continue-with-draft, terminal-question card,
   timestamps.
6. **Interaction dock + new session** — elicitation forms, permission card,
   notifications + Dock badge, workspace/model pickers, create flow,
   settings/unpair/re-pair, onboarding checklist screens.
7. **Packaging + docs** — electron-builder arm64 **signed + notarized**
   dmg (Developer ID — needs the user's cert + notarytool profile at
   packaging time; dev builds stay unsigned until then), README (pairing
   steps, signed-build notes), spec notes, `mac-client-v0.1.0` tag.

Slices 2 and 3 are independent; 1 feeds 4; 5–6 split by renderer module.

## 11. Verification plan

- **Unit** (`tests/mac-client/`): canonical-JSON parity; golden Ed25519
  vectors; **sign with client-core → JSON round-trip → real
  `authorizeRequest` → assert `ok:true`**; body builders vs
  `bodySchemas[method]`; replay/timing edge matrix; pairing proof/receipt
  vs `bridge/src/pairing.ts` functions; electron-dependent modules
  stubbed/lazy-required so root jest doesn't import `electron`.
- **Integration**: `BridgeService` in-process with `FakeSessionAdapter`
  (template: `tests/bridge/bridge-service.test.ts`) driven by real
  client-core envelopes — authz, replay, handle minting, permission gates.
- **E2E acceptance** (live Connector on this Mac):
  *Pairing*: QR-capture → submit → approve (SAS match) → receipt →
  `bridge.health`. Already-paired iPhone unaffected; both devices listed.
  *Steering*: `session.list` → `session.load` (free session) →
  `session.prompt` `{accepted:true}` → reply lands → `session.cancel`.
  *Two-client simultaneity (the actual product claim)*: both devices watch
  the same live turn; cross-device cancel; dual-prompt → one clean 409;
  permission answered on iPhone retires the Mac card; Mac continuation
  visible on iPhone's next list.
  *Locked*: locked session shows explainer → continue-with-draft → new
  `sessionId` navigates + history embedded.
  *Negatives*: consumed offer → 404 warning; expired offer → fresh-code
  copy; revoked device → re-pair state; connector stop mid-request →
  `unavailable`, no crash; 503-after-turn tolerated without banner;
  no `content:read` grant → metadata-only mode; no `prompt:send` →
  read-only composer; `session_discovery_off` → surface Devin CLI state.
- **Gates**: `npx tsc -p bridge/tsconfig.json --noEmit`; root
  `tsc --noEmit` (**requires `mac-client`/`client-core` added to root
  tsconfig `exclude` — the `**/*.ts` glob would otherwise typecheck them
  under the Expo base and fail**; `tests/mac-client/` stays included so
  electron-importing files must stay lazily-required). `client-core` gets
  its own `tsconfig.json` mirroring `bridge/` so it is checked directly,
  not just transitively. Lint: dirs are excluded from root eslint (which
  would fail on Electron globals) — `mac-client/` gets its own
  `eslint --max-warnings 0` config so new code is still linted. `npm test`;
  root audit gate + **separate mac-client audit step** (second lockfile is
  invisible to the gate; electron advisories need entries); `allowScripts`
  entries for electron/electron-builder postinstalls; CI runs on macos-15 +
  windows — keep mac-only imports behind conditional paths.

## 12. Decisions made in revision

- Pairing handoff: **QR screen-capture** (spec-021-clean, zero Connector
  surface) — replaces text/clipboard and socket options.
- Key storage: **safeStorage blob** (unsigned-build-correct) — replaces
  bundled Keychain helper; also removes the asarUnpack packaging risk and
  all per-request spawns.
- `owner` field: **opt-in flag only** — preserves iOS strict schemas.
- Locked-idle detection needs **no bridge change** (activity-absent signal);
  patch 6 exists only for live-turn attribution.
- Background affordances kept via **30 s background list poll** — resolves
  the visibility-gating vs badge/notification contradiction.
- Tray = icon-state; Dock = numeric badge. No client auto-update story
  (clone+build audience; stated in README).

## 13. Decisions (user)

1. **productName**: "Otterin"; device name at pairing: "Otterin (Mac)".
2. **Signing**: Developer ID signed + notarized v1 ($99/yr program —
   user's existing account; cert + notarytool profile needed at packaging).
3. **Scope**: maximal — monitor + steer + answer + create + multi-computer
   + polling modes + notifications. (Protocol limits noted: no image
   attachments — the wire has no upload method; auto-approve mode is
   write-only.)
