# 018 — Authorized local session loading

Status: implemented and synthetically validated; real-account invocation prohibited until a disposable session is selected

## Authoritative contract

This phase follows ACP wire protocol 1 and the official schema-v1.19.0 contract (`a213df5240048f96d2b23f644984bb20c188a234`, reviewed July 10, 2026). `session/load` is available only when initialization returns `agentCapabilities.loadSession: true`.

The request must contain the raw ACP session ID, the session's exact absolute `cwd`, and `mcpServers`. The bridge obtains ID and `cwd` only from a previously validated `session/list` result. It sends an empty MCP list and does not reactivate additional directories, which keeps the load operation inside the primary listed workspace and prevents the phone from selecting paths, processes, arguments, environment variables, MCP servers, or filesystem roots.

During load, the agent replays history as `session/update` notifications and sends the load response only after replay completes. The adapter must therefore scope notifications to one active load, validate them before collection, and never treat an agent-to-client request as approval.

An invalid, excessive, or differently-associated replay notification is discarded without collection and marks the minimized history as truncated. Valid text records from the requested session may still be returned after the validated load response completes. This fails closed for the incompatible record without making one legacy or private update terminate session discovery for every session.

## Privacy and authorization

The mobile request continues to use the opaque `local_` session handle. The server resolves that handle in its bounded, expiring in-memory registry and returns 404 when it is missing, expired, outside a device session scope, or unauthorized.

`session.load` requires `session:content:read` on the server for every request. The default pairing grant remains metadata-only, so discovery does not silently become content access. Connector is authoritative for current content grants, including grants changed after pairing. The mobile client validates returned content but does not reject requests or session titles based on the pairing-time permission snapshot.

Only user and agent text message chunks may cross the bridge. The adapter drops:

- agent thoughts and reasoning;
- tool inputs, outputs, locations, and raw payloads;
- plans, commands, modes, configuration, usage, and extension metadata;
- image, audio, resource, and embedded-resource blocks; and
- unknown update types and fields.

No raw ACP session ID, message ID, full path, additional directory, MCP value, `_meta`, tool data, or unknown field is returned. The mobile response uses sequential display IDs within the opaque session handle.

## Resource limits

- one load at a time per bridge process;
- the session must have appeared in a validated list during the current ACP process lifetime;
- at most 10,000 replay notifications are accepted;
- at most 200 user/agent messages are retained;
- each retained text message is capped at 100,000 characters;
- the final serialized response is reduced from the oldest messages until it fits below 192 KiB, leaving headroom under the 256 KiB pinned transport limit; and
- truncation is disclosed with a boolean flag.

Malformed JSON-RPC, invalid notification/session association, oversized messages, unexpected agent requests, capability absence, timeouts, registry misses, and adapter errors fail closed. Public transport responses remain `not_found`, `invalid_request`, `busy`, or `temporarily_unavailable`; private values and raw errors are never returned or logged.

## Mobile boundary

This spec originally made the local detail route read-only. Spec 023 supersedes that single point by adding a text-only composer when the requesting device currently has `session:prompt:send`. Permission response, tool control, file access, attachments, share/deep links, and background persistence remain unavailable. Local text is selectable but is deliberately not passed through the app's media-aware Markdown renderer, so replayed URLs cannot trigger an automatic external image, audio, or video request. The query remains in memory and is removed when normal TanStack garbage collection runs or all connection data is wiped.

A local discovery row becomes tappable when authenticated bridge health advertises `sessionLoad`, which requires current server-side content permission and ACP support. The default metadata-only row remains non-interactive until the owner grants content access in Connector.

Synthetic coverage verifies capability negotiation, exact listed-`cwd` reuse, empty MCP scope, message minimization, wrong-session rejection, capability absence, notification/message/byte bounds, authorization concealment, opaque-handle resolution, concurrent-load rejection, generic adapter failures, signed mobile request interoperability, strict response sequencing, and conditional row interaction.

## Real-account gate

Automated work uses only a synthetic ACP subprocess. Before invoking `session/load` against the installed Devin CLI, Frank must select or create a disposable session whose workspace and conversation content are safe to replay. The checkpoint must verify message/update shapes without printing raw history to the terminal or test logs.
