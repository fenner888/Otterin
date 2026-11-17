# Local AI evals and red-team regression suite

```sh
npm ci
npm run eval:ai
```

Use Node 24.18.0 (the repository engine). The command uses a separate Jest
configuration inheriting the root Expo preset, aliases and setup. `.eval.ts(x)`
files are not selected by the main test configuration. Any failed safety or
quality assertion exits non-zero: known weaknesses are **not** marked expected
failures, skipped, or converted to passing snapshots.

The reporter writes `evidence/<UTC timestamp>-<short HEAD sha>/results.json` and
`summary.md`, plus individual case JSON records. Metadata includes HEAD, dirty
flag, runtime versions, OS and command. A dirty run describes the working tree,
not only HEAD; retain its evidence with the suite commit. Inputs/observations and
failure messages are capped at 12,000 characters per record/message. Fixtures
are synthetic and safe to commit; never substitute production samples. Keys and
random pending IDs are generated only where the authorization protocol requires
them. Timing, temporary paths and protocol-generated IDs vary between runs.

`evalCase` declares ID, category, target and title; mappings are attached from
`mappings.ts`, the single category/control table. `ev.record(input, observed)`
persists observations even when the following assertion fails. OWASP IDs follow
`toolbox/security-baseline/7-ai.md`'s **2026** table (not older Top 10 numbering).
NIST mappings are control traceability aids, not certification claims.

## Targets inventory

| Feature / trust boundary                              | Local target                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| User task and steering text                           | ACP session/prompt and bridge body schemas                                      |
| Prior conversation / hidden continuation context      | RecoverableSessionDiscoveryAdapter -> embedded transcript resource              |
| Agent tool permission requests and user decisions     | Fake adversarial ACP, signed authorizeRequest, semantic option mapping          |
| Auto-approve / bypass modes                           | ACP session/set_mode, omitted/true/false cases                                  |
| Agent questions / elicitation answers                 | ACP form validation and requested-field constraints                             |
| Agent replies, thoughts, activity and approval labels | Pending approval text and statusLabels vocabulary                               |
| Markdown links and attachment/media output            | Actual DevinMarkdown/InlineMedia render tree, mocked Linking and native media   |
| Provider credentials / child environment              | Fake child records environment **names only**, no values                        |
| Diagnostics                                           | Scrubber and no-op capture boundary                                             |
| Voice dictation vocabulary and Scribe work orders     | Hint filter, deterministic template, mocked Foundation Models result validation |
| Model catalog/picker presentation                     | Deterministic family/variant grouping fixtures                                  |
| Resource exhaustion                                   | Fixed-window limiter capacity and prompt length schemas                         |

## Isolation and interpretation

- No real Devin CLI, real users, production data, VA/federal data, PHI, or real
  `~/.devin` history. ACP executables/logs/workspaces are generated in temporary
  directories and removed in `finally`; the history adapter is an in-memory stub.
- No model/provider/network calls. Jest blocks fetch and Node HTTP/TCP/TLS
  entrypoints; native media is mocked and fake children implement only a local
  stdin/stdout protocol. Do not add executable-path or endpoint overrides.
- Markdown tests use react-native-testing-library. The remote-image finding is
  a native Image URI assignment **before consent**, not an actual network fetch.
- Scope cases directly exercise the signed authorization gate; acceptance is a
  gate-level finding, not proof of exploiting a live connector/session handle.
- Continuation checks prove **protocol/resource containment**, not that an LLM
  will resist instructions inside a transcript. Fake role headings remain raw
  transcript content; there is no claim of model-level semantic isolation.
- Diagnostics has no export backend today; this tests its existing scrubber and
  verifies capture does not log, not a nonexistent production export service.

## Known limits

An undecorated pseudo-heading line cannot be distinguished from prose, so it passes Scribe validation; the mitigation is that the user reviews and edits the preview before applying it.

## Not covered

Devin CLI internals, actual provider payloads/retention/policies, real model
accuracy/jailbreak resistance, native Apple SpeechAnalyzer/FoundationModels
execution (Linux cannot run it), real OS deep-link effects, device networking,
native media downloads, full connector transport/pairing E2E, dependency
vulnerability exploitability and agency/federal authorization are out of scope.
The Scribe tests mock only the native boundary and exercise real JS validation.
This suite is not a VA assessment or authorization to connect to agency systems.

## Existing regression tests

```sh
npm test -- tests/bridge
npm test -- --runTestsByPath tests/bridge/security-core.test.ts
npm run lint && npm run typecheck
```

Keep findings as failures until separately reviewed product fixes land. Never
weaken assertions or modify product code just to make this eval run green.
