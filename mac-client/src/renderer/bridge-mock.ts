/**
 * Stateful fixture mock of `window.otterin` for `vite dev` (and any run where
 * the preload bridge is missing). Returns the same `IpcResult` envelope the
 * real main process will produce — call sites see no difference.
 *
 * Fixture coverage:
 *  - healthy computer "Mac Studio" + a second computer that fails auth
 *    (discovery-notice path).
 *  - sessions in every tier: free, connector_live (streaming `turn.reply`),
 *    awaiting approval (pending permission — retires silently after ~75 s to
 *    demo the another-device-answered path), awaiting answer (elicitation
 *    with all field types), terminal-question, locked-external idle, and an
 *    externally-driven live turn (active, no `turn` — committed-state only).
 *  - prompt/cancel/elicitation/permission responds, continuation on locked
 *    prompt (new sessionId), create_options + create, pairing ceremony.
 */

import type {
  ActivityEntry,
  BridgeErrorCode,
  BridgeFeaturesResult,
  BridgeHealth,
  ComputerModel,
  CreateOptions,
  ElicitationInteraction,
  IpcResult,
  LoadedSession,
  OtterinBridge,
  OtterinChannel,
  PairCapture,
  PairSubmit,
  PairedComputerSummary,
  SessionActivity,
  SessionListPage,
  SessionListRow,
  SessionMessage,
  SessionPermission,
  TurnSnapshot,
} from './types';

const LATENCY_MS = 140;
const PERMISSION_RETIRE_MS = 75_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok<T>(result: T): IpcResult<T> {
  return { ok: true, result };
}

function fail<T>(code: BridgeErrorCode, message: string): IpcResult<T> {
  return { ok: false, error: { code, message } };
}

function lid(stem: string): string {
  return `local_${stem.replace(/[^A-Za-z0-9_-]/g, '')}`.padEnd(48, '0').slice(0, 48);
}

function newSessionId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let suffix = '';
  for (let index = 0; index < 43; index += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `local_${suffix}`;
}

interface MockTurn {
  startedAt: number;
  replyScript: string[];
  /** index into replyScript — one chunk lands per activity poll. */
  replySent: number;
  plan: ActivityEntry[];
  /** index into plan — entries activate one poll at a time. */
  planCursor: number;
}

interface MockSession {
  id: string;
  bridgeId: string;
  workspaceName: string;
  hasTitle: boolean;
  title?: string;
  updatedAt: number;
  model?: ComputerModel;
  owner?: 'free' | 'locked_external' | 'connector_live';
  ownerName?: string;
  messages: SessionMessage[];
  history: ActivityEntry[];
  truncated: boolean;
  /** Externally-owned lock; activity row without a live turn. */
  externalActive: boolean;
  turn: MockTurn | null;
  awaiting: 'answer' | 'approval' | null;
  label: string;
  kind: SessionActivity['kind'];
  permission: SessionPermission | null;
  permissionRetireAt: number;
  elicitation: ElicitationInteraction | null;
  terminalQuestions: { question: string; header?: string; options: string[]; multiSelect: boolean }[] | null;
  /** committed transcript still arriving for an external turn. */
  externalQueue: SessionMessage[];
}

const MODEL_SWE: ComputerModel = {
  id: 'swe-16',
  name: 'SWE-1.6',
  description: 'Devin core engineering model',
  costTier: 'medium',
  recommended: true,
};
const MODEL_SWE_FAST: ComputerModel = {
  id: 'swe-16-fast',
  name: 'SWE-1.6 Fast',
  costTier: 'high',
  costSummary: 'Faster responses, higher unit cost',
};
const MODEL_SWE_LIGHTNING: ComputerModel = {
  id: 'swe-15-lightning',
  name: 'SWE-1.5 Lightning',
  badge: 'free_promo',
  costTier: 'free',
  recent: true,
};
const MODEL_OPUS_HIGH: ComputerModel = {
  id: 'opus-46-high',
  name: 'Claude Opus 4.6 High Thinking',
  costTier: 'high',
  recent: true,
};
const MODEL_OPUS_MED: ComputerModel = {
  id: 'opus-46-med',
  name: 'Claude Opus 4.6 Medium Thinking',
  costTier: 'medium',
};
const MODEL_SONNET: ComputerModel = {
  id: 'sonnet-47',
  name: 'Claude Sonnet 4.7',
  costTier: 'low',
  badge: 'new',
};

const MAC_STUDIO = 'bridge_macstudio0000000000000000000000000000000000';
const FIELD_IMAC = 'bridge_fieldimac000000000000000000000000000000000000';

function base64urlFingerprint(stem: string): string {
  return stem.replace(/[^A-Za-z0-9_-]/g, 'x').padEnd(12, '0').slice(0, 12);
}

function entry(
  id: string,
  afterSequence: number,
  kind: 'thought' | 'tool',
  toolKind: ActivityEntry['toolKind'],
  status: ActivityEntry['status'],
  title: string,
  extra: Partial<ActivityEntry> = {},
): ActivityEntry {
  return { id, afterSequence, kind, toolKind, status, title, truncated: false, ...extra };
}

function makeTurn(startedAt: number): MockTurn {
  return {
    startedAt,
    replySent: 0,
    planCursor: 0,
    replyScript: [
      'Looking at the retry path now. The connector retries once on `busy` then gives up, which drops prompts during a connector restart.',
      'I found the bug: the nonce is minted before the first attempt, so the retry replays a consumed nonce and the bridge 404s the second request.\n\n```ts\n// before — nonce reused across attempts\nconst nonce = randomNonce();\nawait send(envelope(nonce));\nawait send(envelope(nonce)); // replayed → 404\n```',
      'The fix is to mint a fresh envelope per attempt. Updating `retryRequest` in `transport.node.ts` and adding a regression test that asserts a second attempt carries a different `requestId` + `nonce`.',
      'Done. Summary:\n\n- `transport.node.ts`: mint envelope per attempt inside the retry loop\n- `replay.test.ts`: new case "retry sends a fresh nonce" passing\n\nThe connector now survives a restart mid-prompt without dropping the request.',
    ],
    plan: [
      entry('t-1', 0, 'tool', 'read', 'completed', 'Read transport.node.ts', {
        paths: ['src/transport.node.ts'],
        startedAt,
        endedAt: startedAt + 900,
      }),
      entry('t-2', 0, 'thought', undefined, 'completed', 'Reasoning about nonce lifecycle', {
        detail: {
          type: 'text',
          text: 'The replay map keys on (deviceId, nonce). A retried envelope with the same nonce is a replay, so each attempt needs its own signature.',
        },
        startedAt: startedAt + 1_000,
        endedAt: startedAt + 2_800,
      }),
      entry('t-3', 0, 'tool', 'edit', 'running', 'Edit transport.node.ts', {
        paths: ['src/transport.node.ts'],
        detail: {
          type: 'diff',
          path: 'src/transport.node.ts',
          oldText: 'const envelope = mintEnvelope();\nawait send(envelope);\nif (busy) await send(envelope);',
          newText: 'for (const attempt of attempts) {\n  const envelope = mintEnvelope(); // fresh nonce per attempt\n  await send(envelope);\n}',
        },
        startedAt: startedAt + 3_000,
      }),
      entry('t-4', 0, 'tool', 'execute', 'running', 'Run replay tests', {
        detail: { type: 'text', text: '$ npm test -- replay\nPASS tests/bridge/replay.test.ts' },
        startedAt: startedAt + 4_200,
      }),
    ],
  };
}

const GENERIC_TURN_SCRIPT = [
  'On it. Reading the relevant files first.',
  'I have the change sketched out. Applying the edit now.',
  'All set. I updated the code and the tests pass locally.',
];

function makeGenericTurn(startedAt: number): MockTurn {
  return {
    startedAt,
    replySent: 0,
    planCursor: 0,
    replyScript: GENERIC_TURN_SCRIPT,
    plan: [
      entry('g-1', 0, 'tool', 'read', 'running', 'Reading relevant files', { startedAt }),
      entry('g-2', 0, 'tool', 'edit', 'running', 'Applying edits', { startedAt: startedAt + 1_000 }),
      entry('g-3', 0, 'tool', 'execute', 'running', 'Running tests', { startedAt: startedAt + 2_000 }),
    ],
  };
}

export function createMockOtterin(options: { fresh?: boolean } = {}): OtterinBridge {
  const started = Date.now();
  const day = 86_400_000;

  const computers: PairedComputerSummary[] = options.fresh
    ? []
    : [
        {
          bridgeId: MAC_STUDIO,
          computerName: 'Mac Studio',
          pairedAt: started - 9 * day,
          permissions: [
            'bridge:health',
            'session:metadata:read',
            'session:content:read',
            'session:prompt:send',
            'session:create',
          ],
          transportKind: 'tailscale_vpn',
        },
        {
          bridgeId: FIELD_IMAC,
          computerName: 'Field iMac',
          pairedAt: started - 40 * day,
          permissions: ['bridge:health', 'session:metadata:read'],
          transportKind: 'tailscale_vpn',
        },
      ];

  const sessions = new Map<string, MockSession>();

  function addSession(session: MockSession): void {
    sessions.set(session.id, session);
  }

  const liveId = lid('live');
  const approvalId = lid('approval');
  const elicitId = lid('elicit');
  const terminalId = lid('terminal');
  const lockedId = lid('locked');
  const liveExtId = lid('liveext');
  const freeId = lid('free');
  const freeAltId = lid('freealt');

  if (!options.fresh) {
    addSession({
      id: liveId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'Otterin',
      hasTitle: true,
      title: 'Fix connector retry dropping prompts',
      updatedAt: started - 40_000,
      model: MODEL_SWE,
      owner: 'connector_live',
      messages: [
        { sequence: 1, source: 'user', text: 'The connector drops prompts when it restarts mid-request. Can you look?', createdAt: started - day - 3_600_000 },
        { sequence: 2, source: 'devin', text: 'I traced the drop to envelope reuse across retries. A fix is sketched below.', createdAt: started - day - 3_500_000 },
        { sequence: 3, source: 'user', text: 'Nice. Make sure a retried request gets a fresh nonce.', createdAt: started - 120_000 },
      ],
      history: [
        entry('h-1', 2, 'tool', 'read', 'completed', 'Read replay.ts', {
          paths: ['src/replay.ts'],
          startedAt: started - day - 3_550_000,
          endedAt: started - day - 3_540_000,
        }),
        entry('h-2', 2, 'tool', 'execute', 'completed', 'Ran bridge test suite', {
          detail: { type: 'text', text: '$ npm test\nPASS 42 tests' },
          startedAt: started - day - 3_500_000,
          endedAt: started - day - 3_480_000,
        }),
        entry('h-3', 3, 'thought', undefined, 'completed', 'Planning nonce fix', {
          detail: { type: 'text', text: 'Mint per attempt; never resend a signed envelope.' },
          startedAt: started - 118_000,
          endedAt: started - 117_000,
        }),
      ],
      truncated: false,
      externalActive: false,
      turn: makeTurn(started - 30_000),
      awaiting: null,
      label: 'Editing files',
      kind: 'editing',
      permission: null,
      permissionRetireAt: 0,
      elicitation: null,
      terminalQuestions: null,
      externalQueue: [],
    });

    addSession({
      id: approvalId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'tourpro',
      hasTitle: true,
      title: 'Migrate settings store to zustand',
      updatedAt: started - 90_000,
      model: MODEL_OPUS_HIGH,
      owner: 'connector_live',
      messages: [
        { sequence: 1, source: 'user', text: 'Move the settings store over to zustand, keeping the persisted shape identical.', createdAt: started - 3_000_000 },
        { sequence: 2, source: 'devin', text: 'Migration plan looks safe. I need to run the app test suite to confirm parity.', createdAt: started - 2_900_000 },
      ],
      history: [
        entry('a-1', 2, 'tool', 'edit', 'completed', 'Edit settings store', {
          paths: ['src/store/settings.ts'],
          startedAt: started - 2_800_000,
          endedAt: started - 2_600_000,
        }),
      ],
      truncated: false,
      externalActive: false,
      turn: {
        startedAt: started - 200_000,
        replySent: 1,
        replyScript: ['I need approval to run the test suite before finishing this migration.'],
        planCursor: 1,
        plan: [
          entry('a-t1', 0, 'tool', 'execute', 'awaiting_input', 'Run npm test', {
            paths: [],
            detail: { type: 'text', text: '$ npm test' },
            startedAt: started - 180_000,
          }),
        ],
      },
      awaiting: 'approval',
      label: 'Waiting for your approval',
      kind: 'executing',
      permission: {
        id: `permission_${'a'.repeat(43)}`,
        title: 'Run the workspace test suite',
        toolKind: 'execute',
        command: 'npm test -- --runInBand',
        paths: ['package.json', 'tests/'],
        decisions: ['allow_once', 'allow_session', 'reject_once'],
        createdAt: started - 160_000,
        expiresAt: started + 600_000,
      },
      permissionRetireAt: started + PERMISSION_RETIRE_MS,
      elicitation: null,
      terminalQuestions: null,
      externalQueue: [],
    });

    addSession({
      id: elicitId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'otterin-docs',
      hasTitle: true,
      title: 'Draft release notes for 0.2',
      updatedAt: started - 150_000,
      model: MODEL_SONNET,
      messages: [
        { sequence: 1, source: 'user', text: 'Draft release notes covering the mac-client work since 0.1.', createdAt: started - 500_000 },
      ],
      history: [],
      truncated: false,
      externalActive: false,
      turn: {
        startedAt: started - 240_000,
        replySent: 0,
        replyScript: [''],
        planCursor: 0,
        plan: [],
      },
      awaiting: 'answer',
      label: 'Waiting for your answer',
      kind: 'thinking',
      permission: null,
      permissionRetireAt: 0,
      elicitation: {
        id: `interaction_${'e'.repeat(43)}`,
        title: 'Release-notes scope',
        message: 'A few choices will shape the draft.',
        description: 'Answer what you can; Devin fills in the rest.',
        createdAt: started - 230_000,
        fields: [
          {
            key: 'audience',
            type: 'single_select',
            title: 'Who are these notes for?',
            required: true,
            allowOther: true,
            options: [
              { value: 'users', label: 'End users' },
              { value: 'contributors', label: 'Contributors' },
              { value: 'internal', label: 'Internal changelog' },
            ],
          },
          {
            key: 'sections',
            type: 'multi_select',
            title: 'Which sections should be included?',
            required: true,
            minItems: 1,
            options: [
              { value: 'features', label: 'New features' },
              { value: 'fixes', label: 'Bug fixes' },
              { value: 'security', label: 'Security notes' },
              { value: 'known', label: 'Known issues' },
            ],
          },
          {
            key: 'codename',
            type: 'text',
            title: 'Release codename',
            description: 'Optional — leave blank for a plain versioned release.',
            required: false,
            maxLength: 40,
          },
          {
            key: 'beta',
            type: 'boolean',
            title: 'Tag as beta?',
            required: true,
            defaultValue: false,
          },
          {
            key: 'milestone',
            type: 'integer',
            title: 'Milestone number',
            required: true,
            minimum: 1,
            maximum: 99,
            defaultValue: 2,
          },
          {
            key: 'budget',
            type: 'number',
            title: 'Max words (hundreds)',
            required: false,
            minimum: 0,
            maximum: 50,
          },
        ],
      },
      terminalQuestions: null,
      externalQueue: [],
    });

    addSession({
      id: terminalId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'infra',
      hasTitle: true,
      title: 'Provision staging certificates',
      updatedAt: started - 300_000,
      model: MODEL_SWE,
      messages: [
        { sequence: 1, source: 'user', text: 'Provision the staging certs and verify the SANs match the inventory.', createdAt: started - 900_000 },
        { sequence: 2, source: 'devin', text: 'One inventory entry is ambiguous; I asked a follow-up in the terminal.', createdAt: started - 800_000 },
      ],
      history: [],
      truncated: false,
      externalActive: false,
      turn: {
        startedAt: started - 700_000,
        replySent: 0,
        replyScript: [''],
        planCursor: 0,
        plan: [],
      },
      awaiting: 'answer',
      label: 'Waiting for your answer in Terminal',
      kind: 'executing',
      permission: null,
      permissionRetireAt: 0,
      elicitation: null,
      terminalQuestions: [
        {
          question: 'Which SAN set should the staging cert cover?',
          header: 'Certificate inventory',
          options: ['staging.tourpro.app only', 'All staging subdomains', 'Wildcard + api.staging'],
          multiSelect: false,
        },
      ],
      externalQueue: [],
    });

    addSession({
      id: lockedId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'webapp',
      hasTitle: true,
      title: 'Q3 analytics dashboard',
      updatedAt: started - 7_200_000,
      model: MODEL_OPUS_MED,
      owner: 'locked_external',
      ownerName: 'Devin',
      messages: [
        { sequence: 1, source: 'user', text: 'Build the Q3 analytics dashboard on the existing metrics API.', createdAt: started - 2 * day - 5_000_000 },
        { sequence: 2, source: 'devin', text: 'Dashboard skeleton is up: revenue, retention, and cohort panels wired to `/api/metrics`.', createdAt: started - 2 * day - 4_800_000 },
        { sequence: 3, source: 'user', text: 'Add export-to-CSV on each panel.', createdAt: started - 7_400_000 },
        { sequence: 4, source: 'devin', text: 'CSV export added to all three panels with filter parity.', createdAt: started - 7_300_000 },
      ],
      history: [
        entry('l-1', 4, 'tool', 'edit', 'completed', 'Edit dashboard panels', {
          paths: ['src/panels/Revenue.tsx', 'src/panels/Retention.tsx', 'src/panels/Cohorts.tsx'],
          startedAt: started - 7_380_000,
          endedAt: started - 7_320_000,
        }),
      ],
      truncated: true,
      externalActive: false,
      turn: null,
      awaiting: null,
      label: 'Response ready',
      kind: 'responding',
      permission: null,
      permissionRetireAt: 0,
      elicitation: null,
      terminalQuestions: null,
      externalQueue: [],
    });

    addSession({
      id: liveExtId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'otterin',
      hasTitle: true,
      title: 'Fix flaky CI shard',
      updatedAt: started - 20_000,
      model: MODEL_SWE,
      owner: 'locked_external',
      ownerName: 'Devin',
      messages: [
        { sequence: 1, source: 'user', text: 'The bridge-service shard flakes about 1 in 8 runs. Find the race.', createdAt: started - 4_000_000 },
        { sequence: 2, source: 'devin', text: 'Reproduced locally: the listener closes before the last keep-alive write flushes.', createdAt: started - 3_600_000 },
      ],
      history: [],
      truncated: false,
      externalActive: true,
      turn: null,
      awaiting: null,
      label: 'Working',
      kind: 'executing',
      permission: null,
      permissionRetireAt: 0,
      elicitation: null,
      terminalQuestions: null,
      externalQueue: [
        { sequence: 3, source: 'devin', text: 'Patch candidate: drain pending writes before `server.close`. Testing under 50 repeated runs now.', createdAt: started + 60_000 },
        { sequence: 4, source: 'devin', text: '50/50 clean runs. The drain fix holds — pushing the branch.', createdAt: started + 150_000 },
      ],
    });

    addSession({
      id: freeId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'docs',
      hasTitle: true,
      title: 'Write onboarding docs',
      updatedAt: started - 3 * day,
      model: MODEL_SONNET,
      owner: 'free',
      messages: [
        { sequence: 1, source: 'user', text: 'Write a getting-started guide for the connector.', createdAt: started - 3 * day - 2_000_000 },
        { sequence: 2, source: 'devin', text: 'Guide drafted at docs/getting-started.md with pairing, grants, and troubleshooting sections.', createdAt: started - 3 * day - 1_900_000 },
      ],
      history: [
        entry('f-1', 2, 'tool', 'edit', 'completed', 'Wrote getting-started.md', {
          paths: ['docs/getting-started.md'],
          startedAt: started - 3 * day - 1_950_000,
          endedAt: started - 3 * day - 1_920_000,
        }),
      ],
      truncated: false,
      externalActive: false,
      turn: null,
      awaiting: null,
      label: 'Response ready',
      kind: 'responding',
      permission: null,
      permissionRetireAt: 0,
      elicitation: null,
      terminalQuestions: null,
      externalQueue: [],
    });

    addSession({
      id: freeAltId,
      bridgeId: MAC_STUDIO,
      workspaceName: 'otterin',
      hasTitle: false,
      updatedAt: started - 6 * day,
      messages: [
        { sequence: 1, source: 'user', text: 'Bump vite to 5.4 across the repo.', createdAt: started - 6 * day },
      ],
      history: [],
      truncated: false,
      externalActive: false,
      turn: null,
      awaiting: null,
      label: 'Response ready',
      kind: 'responding',
      permission: null,
      permissionRetireAt: 0,
      elicitation: null,
      terminalQuestions: null,
      externalQueue: [],
    });
  }

  let catalogIsLive = false;
  let pairingSubmittedAt = 0;
  let nextComputerIndex = 0;

  function listRow(session: MockSession): SessionListRow {
    const active = session.turn !== null || session.externalActive;
    return {
      id: session.id,
      origin: 'computer',
      workspaceName: session.workspaceName,
      hasTitle: session.hasTitle,
      ...(session.title !== undefined ? { title: session.title } : {}),
      updatedAt: new Date(session.updatedAt).toISOString(),
      ...(session.model ? { model: session.model } : {}),
      ...(session.owner ? { owner: session.owner } : {}),
      ...(session.ownerName ? { ownerName: session.ownerName } : {}),
      ...(session.owner !== 'free'
        ? {
            activity: {
              active,
              kind: session.kind,
              updatedAt: session.updatedAt,
              ...(session.awaiting ? { awaiting: session.awaiting } : {}),
            },
          }
        : {}),
    };
  }

  function advanceTurn(session: MockSession): void {
    const turn = session.turn;
    if (!turn || session.awaiting) return; // a pending interaction pauses the turn
    // Each poll completes the oldest still-running plan entry, then streams
    // one reply chunk once the plan is exhausted.
    if (turn.planCursor < turn.plan.length) {
      const current = turn.plan[turn.planCursor];
      if (current && current.status === 'running') current.status = 'completed';
      turn.planCursor += 1;
      session.updatedAt = Date.now();
      return;
    }
    if (turn.replySent < turn.replyScript.length) {
      turn.replySent += 1;
      session.updatedAt = Date.now();
      return;
    }
    for (const planEntry of turn.plan) {
      if (planEntry.status === 'running') planEntry.status = 'completed';
    }
    const reply = turnReply(turn);
    if (reply) {
      const next = nextSequence(session);
      session.messages.push({ sequence: next, source: 'devin', text: reply, createdAt: Date.now() });
      for (const planEntry of turn.plan) {
        planEntry.afterSequence = next;
        session.history.push(planEntry);
      }
    }
    session.turn = null;
    session.label = 'Response ready';
    session.kind = 'responding';
    session.updatedAt = Date.now();
  }

  function turnReply(turn: MockTurn): string {
    return turn.replyScript.slice(0, turn.replySent).filter(Boolean).join('\n\n');
  }

  function turnSnapshot(turn: MockTurn): TurnSnapshot {
    return { startedAt: turn.startedAt, reply: turnReply(turn), activity: turn.plan };
  }

  function nextSequence(session: MockSession): number {
    return session.messages.length + 1;
  }

  function pumpExternal(session: MockSession): void {
    if (!session.externalActive) return;
    const pending = session.externalQueue[0];
    if (pending && pending.createdAt !== undefined && pending.createdAt <= Date.now()) {
      session.externalQueue.shift();
      session.messages.push({ ...pending, sequence: nextSequence(session) });
      session.updatedAt = Date.now();
    }
    if (session.externalQueue.length === 0) {
      session.externalActive = false;
      session.label = 'Response ready';
      session.kind = 'responding';
    }
  }

  function sessionFor(bridgeId: string, sessionId: string): MockSession | undefined {
    const session = sessions.get(sessionId);
    return session && session.bridgeId === bridgeId ? session : undefined;
  }

  function anyTurnActive(): boolean {
    for (const session of sessions.values()) {
      if (session.turn) return true;
    }
    return false;
  }

  function requireComputer(bridgeId: string): PairedComputerSummary | IpcResult<never> {
    const computer = computers.find((candidate) => candidate.bridgeId === bridgeId);
    if (!computer) {
      return fail('authorization_failed', 'This Mac is no longer authorized by that computer.');
    }
    return computer;
  }

  function isComputer(value: unknown): value is PairedComputerSummary {
    return Boolean(value) && typeof value === 'object' && 'computerName' in (value as object);
  }

  async function invoke(channel: OtterinChannel, payload?: unknown): Promise<IpcResult<unknown>> {
    await sleep(LATENCY_MS);
    const body = (payload ?? {}) as Record<string, unknown>;
    const bridgeId = typeof body.bridgeId === 'string' ? body.bridgeId : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';

    switch (channel) {
      case 'computers:list':
        return ok([...computers]);

      case 'computers:disconnect': {
        const index = computers.findIndex((candidate) => candidate.bridgeId === bridgeId);
        if (index === -1) return fail('authorization_failed', 'Unknown computer.');
        computers.splice(index, 1);
        for (const [id, session] of sessions) {
          if (session.bridgeId === bridgeId) sessions.delete(id);
        }
        return ok({ disconnected: true as const });
      }

      case 'device:revoke': {
        const computer = requireComputer(bridgeId);
        if (!isComputer(computer)) return computer;
        const index = computers.findIndex((candidate) => candidate.bridgeId === bridgeId);
        if (index !== -1) computers.splice(index, 1);
        for (const [id, session] of sessions) {
          if (session.bridgeId === bridgeId) sessions.delete(id);
        }
        return ok({ revoked: true as const });
      }

      case 'bridge:health': {
        const computer = requireComputer(bridgeId);
        if (!isComputer(computer)) return computer;
        const result: BridgeHealth = {
          protocolVersion: 2,
          status: 'ready',
          capabilities: { sessionList: true, sessionLoad: true, sessionPrompt: true },
        };
        return ok(result);
      }

      case 'bridge:features': {
        const computer = requireComputer(bridgeId);
        if (!isComputer(computer)) return computer;
        const result: BridgeFeaturesResult = {
          sessionElicitation: true,
          activityTimeline: true,
          permissionPrompts: true,
          sessionCancel: true,
          autoApprove: true,
          ...(body.presentation === true
            ? {
                presentation: {
                  messageTimestamps: true,
                  grants: { viewSessions: true, sendPrompts: true, startSessions: true },
                },
              }
            : {}),
        };
        return ok(result);
      }

      case 'bridge:version': {
        const computer = requireComputer(bridgeId);
        if (!isComputer(computer)) return computer;
        return ok({ version: '0.2.0' });
      }

      case 'session:list': {
        const computer = requireComputer(bridgeId);
        if (!isComputer(computer)) return computer;
        for (const session of sessions.values()) pumpExternal(session);
        const page: SessionListPage = {
          sessions: [...sessions.values()]
            .filter((session) => session.bridgeId === bridgeId)
            .map(listRow)
            .sort((a, b) => Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0')),
        };
        return ok(page);
      }

      case 'session:load': {
        const session = sessionFor(bridgeId, sessionId);
        if (!session) return fail('authorization_failed', 'Session handle expired.');
        pumpExternal(session);
        const result: LoadedSession = {
          session: {
            id: session.id,
            origin: 'computer',
            workspaceName: session.workspaceName,
            ...(session.model ? { model: session.model } : {}),
            ...(session.owner ? { owner: session.owner } : {}),
            ...(session.ownerName ? { ownerName: session.ownerName } : {}),
          },
          messages: session.messages.map((message, index) => ({ ...message, sequence: index + 1 })),
          activity: session.history,
          truncated: session.truncated,
        };
        return ok(result);
      }

      case 'session:activity': {
        const session = sessionFor(bridgeId, sessionId);
        if (!session) return fail('authorization_failed', 'Session handle expired.');
        pumpExternal(session);
        advanceTurn(session);
        if (session.awaiting === 'approval' && session.permissionRetireAt <= Date.now()) {
          // Another device answered — the pending card retires silently.
          session.permission = null;
          session.awaiting = null;
          session.label = 'Editing files';
        }
        const result: SessionActivity = {
          active: session.turn !== null || session.externalActive,
          kind: session.kind,
          label: session.label,
          updatedAt: session.updatedAt,
          ...(session.awaiting ? { awaiting: session.awaiting } : {}),
          ...(session.terminalQuestions ? { terminalQuestion: { questions: session.terminalQuestions } } : {}),
          ...(session.turn ? { turn: turnSnapshot(session.turn) } : {}),
        };
        return ok(result);
      }

      case 'session:elicitation': {
        const session = sessionFor(bridgeId, sessionId);
        if (!session) return fail('authorization_failed', 'Session handle expired.');
        return ok({ interaction: session.awaiting === 'answer' ? session.elicitation : null });
      }

      case 'session:elicitation:respond': {
        const session = sessionFor(bridgeId, sessionId);
        if (!session || !session.elicitation) return fail('authorization_failed', 'Interaction expired.');
        session.elicitation = null;
        session.awaiting = null;
        session.label = 'Working';
        if (session.turn) {
          session.turn.replyScript = ['Thanks — drafting the notes with that scope now.', 'Release notes drafted at docs/releases/0.2.md covering all selected sections.'];
          session.turn.plan = [
            entry('r-1', 0, 'tool', 'edit', 'running', 'Write docs/releases/0.2.md', {
              paths: ['docs/releases/0.2.md'],
              startedAt: Date.now(),
            }),
          ];
          session.turn.planCursor = 0;
        }
        return ok({ accepted: true as const });
      }

      case 'session:permission': {
        const session = sessionFor(bridgeId, sessionId);
        if (!session) return fail('authorization_failed', 'Session handle expired.');
        const live =
          session.permission !== null &&
          session.permissionRetireAt > Date.now() &&
          session.awaiting === 'approval';
        return ok({ permission: live ? session.permission : null });
      }

      case 'session:permission:respond': {
        const session = sessionFor(bridgeId, sessionId);
        if (!session || !session.permission) return fail('authorization_failed', 'Permission expired.');
        session.permission = null;
        session.awaiting = null;
        session.label = 'Working';
        if (session.turn) {
          session.turn.replyScript = ['Test suite is green. The zustand migration is complete and persisted shape is unchanged.'];
          session.turn.replySent = 0;
          session.turn.plan = [
            entry('p-t1', 0, 'tool', 'execute', 'running', 'Run npm test', {
              detail: { type: 'text', text: '$ npm test\nPASS 87 tests' },
              startedAt: Date.now(),
            }),
          ];
          session.turn.planCursor = 0;
        }
        return ok({ accepted: true as const });
      }

      case 'session:prompt': {
        const session = sessionFor(bridgeId, sessionId);
        if (!session) return fail('authorization_failed', 'Session handle expired.');
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) return fail('invalid_request', 'Empty prompt.');
        if (anyTurnActive()) {
          return fail('conflict', 'The connector is busy with another turn.');
        }
        if (session.owner === 'locked_external' || session.externalActive) {
          // Locked sessions continue as a fork: a new session embedding the
          // prior transcript plus the prompt. The locked session's own
          // transcript is untouched.
          const continuedId = newSessionId();
          const continued: MockSession = {
            id: continuedId,
            bridgeId,
            workspaceName: session.workspaceName,
            hasTitle: false,
            updatedAt: Date.now(),
            model: session.model,
            owner: 'connector_live',
            messages: [
              ...session.messages.map((message, index) => ({ ...message, sequence: index + 1 })),
              { sequence: session.messages.length + 1, source: 'user', text, createdAt: Date.now() },
            ],
            history: [],
            truncated: false,
            externalActive: false,
            turn: makeGenericTurn(Date.now()),
            awaiting: null,
            label: 'Thinking',
            kind: 'thinking',
            permission: null,
            permissionRetireAt: 0,
            elicitation: null,
            terminalQuestions: null,
            externalQueue: [],
          };
          addSession(continued);
          session.updatedAt = Date.now();
          return ok({ accepted: true as const, sessionId: continuedId });
        }
        session.messages.push({
          sequence: nextSequence(session),
          source: 'user',
          text,
          createdAt: Date.now(),
        });
        session.turn = makeGenericTurn(Date.now());
        session.owner = 'connector_live';
        session.externalActive = false;
        session.label = 'Thinking';
        session.kind = 'thinking';
        session.updatedAt = Date.now();
        return ok({ accepted: true as const });
      }

      case 'session:cancel': {
        const target = [...sessions.values()].find((session) => session.turn);
        if (!target || target.id !== sessionId) {
          return fail('conflict', 'The session is not running in the Connector.');
        }
        for (const planEntry of target.turn?.plan ?? []) {
          if (planEntry.status === 'running') planEntry.status = 'interrupted';
        }
        const reply = turnReply(target.turn ?? { startedAt: 0, replySent: 0, replyScript: [], planCursor: 0, plan: [] });
        if (reply) {
          const next = nextSequence(target);
          target.messages.push({ sequence: next, source: 'devin', text: reply, createdAt: Date.now() });
          for (const planEntry of target.turn?.plan ?? []) {
            planEntry.afterSequence = next;
            target.history.push(planEntry);
          }
        }
        target.turn = null;
        target.awaiting = null;
        target.permission = null;
        target.elicitation = null;
        target.label = 'Response ready';
        target.updatedAt = Date.now();
        return ok({ cancelled: true as const });
      }

      case 'session:createOptions': {
        const computer = requireComputer(bridgeId);
        if (!isComputer(computer)) return computer;
        if (body.refresh === true) catalogIsLive = true;
        const models = catalogIsLive
          ? [MODEL_SWE, MODEL_SWE_FAST, MODEL_SWE_LIGHTNING, MODEL_OPUS_HIGH, MODEL_OPUS_MED, MODEL_SONNET]
          : [MODEL_SWE, MODEL_SWE_LIGHTNING, MODEL_OPUS_HIGH];
        const result: CreateOptions = {
          workspaces: [
            { id: `workspace_${'o'.repeat(43)}`, name: 'Otterin' },
            { id: `workspace_${'t'.repeat(43)}`, name: 'tourpro' },
            { id: `workspace_${'w'.repeat(43)}`, name: 'webapp' },
            { id: `workspace_${'d'.repeat(43)}`, name: 'docs' },
            { id: `workspace_${'i'.repeat(43)}`, name: 'infra' },
            { id: `workspace_${'x'.repeat(43)}`, name: 'Otterin' },
          ],
          models,
          defaultModelId: MODEL_SWE.id,
          catalogSource: catalogIsLive ? 'live' : 'recent',
        };
        return ok(result);
      }

      case 'session:create': {
        const computer = requireComputer(bridgeId);
        if (!isComputer(computer)) return computer;
        if (anyTurnActive()) return fail('unavailable', 'The connector is busy with another turn.');
        const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
        const workspaceNames = new Map<string, string>([
          [`workspace_${'o'.repeat(43)}`, 'Otterin'],
          [`workspace_${'t'.repeat(43)}`, 'tourpro'],
          [`workspace_${'w'.repeat(43)}`, 'webapp'],
          [`workspace_${'d'.repeat(43)}`, 'docs'],
          [`workspace_${'i'.repeat(43)}`, 'infra'],
          [`workspace_${'x'.repeat(43)}`, 'Otterin'],
        ]);
        const name = workspaceNames.get(workspaceId) ?? 'workspace';
        const text = typeof body.text === 'string' ? body.text : '';
        if (!text.trim()) return fail('invalid_request', 'Empty prompt.');
        const createdId = newSessionId();
        const created: MockSession = {
          id: createdId,
          bridgeId,
          workspaceName: name,
          hasTitle: false,
          updatedAt: Date.now(),
          model: MODEL_SWE,
          owner: 'connector_live',
          messages: [{ sequence: 1, source: 'user', text, createdAt: Date.now() }],
          history: [],
          truncated: false,
          externalActive: false,
          turn: makeGenericTurn(Date.now()),
          awaiting: null,
          label: 'Setting up',
          kind: 'thinking',
          permission: null,
          permissionRetireAt: 0,
          elicitation: null,
          terminalQuestions: null,
          externalQueue: [],
        };
        const modelId = typeof body.modelId === 'string' ? body.modelId : null;
        if (modelId) {
          created.model = [MODEL_SWE, MODEL_SWE_FAST, MODEL_SWE_LIGHTNING, MODEL_OPUS_HIGH, MODEL_OPUS_MED, MODEL_SONNET].find(
            (model) => model.id === modelId,
          );
        }
        addSession(created);
        return ok({ accepted: true as const, sessionId: createdId });
      }

      case 'pair:capture': {
        await sleep(1_200);
        const result: PairCapture = {
          status: 'captured',
          computerName: nextComputerIndex === 0 ? 'Mac Studio' : `Office Mac ${nextComputerIndex}`,
          bridgeKeyFingerprint: base64urlFingerprint('bridgekey').padEnd(43, 'x'),
          deviceKeyFingerprint: base64urlFingerprint('thismac'),
          expiresAt: Date.now() + 110_000,
        };
        return ok(result);
      }

      case 'pair:submit': {
        if (pairingSubmittedAt === 0) pairingSubmittedAt = Date.now();
        await sleep(4_500);
        const index = nextComputerIndex;
        nextComputerIndex += 1;
        const bridgeIdNew = `bridge_pair${`${index}`.padEnd(3, '0')}${'p'.repeat(40)}`;
        const name = index === 0 ? 'Mac Studio' : `Office Mac ${index}`;
        computers.push({
          bridgeId: bridgeIdNew,
          computerName: name,
          pairedAt: Date.now(),
          permissions: [
            'bridge:health',
            'session:metadata:read',
            'session:content:read',
          ],
          transportKind: 'tailscale_vpn',
        });
        const result: PairSubmit = { status: 'approved', computerName: name };
        return ok(result);
      }

      case 'app:openConnector':
      case 'app:openDevin':
        return ok({ opened: true });

      default:
        return fail('unsupported_method', `Unhandled channel ${channel}`);
    }
  }

  return { invoke };
}
