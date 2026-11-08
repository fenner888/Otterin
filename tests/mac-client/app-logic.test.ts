import {
  activityGroupStatus,
  activityShortLabel,
  activityStatusLabel,
  devinReplySignature,
  discoveryErrorCopy,
  elicitationSummary,
  formatRelativeTime,
  groupActivity,
  groupComputerModels,
  familyForModelId,
  hasSettledNewDevinReply,
  loadComputerSessionBoard,
  localOptionsFailureCopy,
  messageTimeLabels,
  preferredFamilyVariant,
  promptErrorMessage,
  publicErrorMessage,
  resolveComputerGrants,
  sessionTimeLabel,
  splitComputerModelName,
  summarizeActivity,
  type ComputerDiscoveryStatus,
} from '../../client-core/src/app-logic';
import {
  ComputerBridgeError,
  type ComputerActivityEntry,
  type ComputerSessionSummary,
} from '../../client-core/src/computerBridge';
import {
  InMemorySecretStore,
  NodeDeviceCrypto,
  RecordingTransport,
  TEST_BRIDGE_ID,
  registerPorts,
  seedPairedComputer,
} from './helpers';

const HEALTH = (sessionList = true) => ({
  protocolVersion: 2,
  status: 'ready',
  capabilities: { sessionList, sessionLoad: true, sessionPrompt: true },
});

function sessionRow(idSuffix: string, updatedAt?: string): ComputerSessionSummary {
  return {
    id: `local_${idSuffix.padEnd(43, 'x')}`,
    origin: 'computer',
    workspaceName: 'weather-app',
    hasTitle: false,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

const ACTIVITY_BASE: ComputerActivityEntry = {
  id: 'e1',
  afterSequence: 1,
  kind: 'tool',
  status: 'completed',
  title: 'Read file',
  truncated: false,
};

describe('app-logic session board', () => {
  let crypto: NodeDeviceCrypto;
  let store: InMemorySecretStore;

  beforeEach(() => {
    crypto = new NodeDeviceCrypto();
    store = new InMemorySecretStore();
  });

  function boardTransport(pages: Array<{ sessions: ComputerSessionSummary[]; nextCursor?: string }>) {
    const pageQueue = [...pages];
    return new RecordingTransport((_path, body) => {
      const method = (body as { method?: string }).method;
      if (method === 'bridge.health') return { status: 200, body: HEALTH() };
      if (method === 'session.list') {
        const page = pageQueue.shift() ?? { sessions: [] };
        return { status: 200, body: page };
      }
      return { status: 200, body: {} };
    });
  }

  it('merges bounded pages into a sorted session board', async () => {
    const transport = boardTransport([
      {
        sessions: [sessionRow('aaa', '2027-01-01T00:00:00Z'), sessionRow('bbb', '2027-01-03T00:00:00Z')],
        nextCursor: 'c2',
      },
      { sessions: [sessionRow('ccc', '2027-01-02T00:00:00Z')] },
    ]);
    registerPorts(crypto, transport, store);
    const seeded = await seedPairedComputer({ crypto });
    const board = await loadComputerSessionBoard([
      { ...seeded.credential, transportKind: 'tailscale_vpn' },
    ]);

    expect(board.computers[0]!.state).toBe('ready');
    expect(board.sessions.map((session) => session.id)).toEqual([
      `local_${'bbb'.padEnd(43, 'x')}`,
      `local_${'ccc'.padEnd(43, 'x')}`,
      `local_${'aaa'.padEnd(43, 'x')}`,
    ]);
    expect(board.sessions[0]!.canLoad).toBe(true);
    expect(board.lastSuccessfulAt).toBeDefined();
  });

  it('reports session_discovery_off when the bridge lacks the capability', async () => {
    const transport = new RecordingTransport((_path, body) => {
      const method = (body as { method?: string }).method;
      if (method === 'bridge.health') return { status: 200, body: HEALTH(false) };
      return { status: 200, body: {} };
    });
    registerPorts(crypto, transport, store);
    const seeded = await seedPairedComputer({ crypto });
    const board = await loadComputerSessionBoard([
      { ...seeded.credential, transportKind: 'tailscale_vpn' },
    ]);
    expect(board.computers[0]!.state).toBe('session_discovery_off');
    expect(board.sessions).toEqual([]);
  });

  it('flags a repeated cursor as invalid_response', async () => {
    const transport = boardTransport([
      { sessions: [sessionRow('aaa')], nextCursor: 'repeat' },
      { sessions: [sessionRow('bbb')], nextCursor: 'repeat' },
    ]);
    registerPorts(crypto, transport, store);
    const seeded = await seedPairedComputer({ crypto });
    const board = await loadComputerSessionBoard([
      { ...seeded.credential, transportKind: 'tailscale_vpn' },
    ]);
    expect(board.computers[0]!.state).toBe('invalid_response');
  });

  it('flags more than five pages as too_many_sessions', async () => {
    const transport = boardTransport(
      Array.from({ length: 7 }, (_, index) => ({
        sessions: [sessionRow(`s${index}`)],
        nextCursor: `cursor-${index}`,
      })),
    );
    registerPorts(crypto, transport, store);
    const seeded = await seedPairedComputer({ crypto });
    const board = await loadComputerSessionBoard([
      { ...seeded.credential, transportKind: 'tailscale_vpn' },
    ]);
    expect(board.computers[0]!.state).toBe('too_many_sessions');
  });

  it('maps a 404 to authorization_failed', async () => {
    const transport = new RecordingTransport(() => ({
      status: 404,
      body: { error: 'not_found' },
    }));
    registerPorts(crypto, transport, store);
    const seeded = await seedPairedComputer({ crypto });
    const board = await loadComputerSessionBoard([
      { ...seeded.credential, transportKind: 'tailscale_vpn' },
    ]);
    expect(board.computers[0]!.state).toBe('authorization_failed');
  });

  it('keeps the previous sessions when a poll fails unavailable', async () => {
    const good = boardTransport([{ sessions: [sessionRow('aaa', '2027-01-01T00:00:00Z')] }]);
    registerPorts(crypto, good, store);
    const seeded = await seedPairedComputer({ crypto });
    const summary = { ...seeded.credential, transportKind: 'tailscale_vpn' as const };
    const first = await loadComputerSessionBoard([summary]);
    expect(first.sessions).toHaveLength(1);

    const failing = new RecordingTransport(() => {
      throw new Error('connection refused');
    });
    registerPorts(crypto, failing, store);
    const second = await loadComputerSessionBoard([summary], first);
    expect(second.computers[0]!.state).toBe('unavailable');
    expect(second.sessions).toEqual(first.sessions);
    expect(second.lastSuccessfulAt).toBe(first.lastSuccessfulAt);
  });
});

describe('app-logic grant resolution + error copy', () => {
  it('maps connector presentation grants when available', () => {
    const resolution = resolveComputerGrants(
      {
        messageTimestamps: true,
        grants: { viewSessions: true, sendPrompts: false, startSessions: true },
      },
      undefined,
    );
    expect(resolution).toEqual({
      grants: { viewSessions: true, sendPrompts: false, startSessions: true },
      source: 'connector',
    });
  });

  it('falls back to pairing permissions and hides missing grants', () => {
    const resolution = resolveComputerGrants(null, {
      bridgeId: TEST_BRIDGE_ID,
      computerName: 'Mac',
      pairedAt: 1,
      permissions: ['bridge:health', 'session:metadata:read', 'session:content:read'],
      transportKind: 'tailscale_vpn',
    });
    expect(resolution).toEqual({
      grants: { viewSessions: true, sendPrompts: false, startSessions: false },
      source: 'pairing',
    });
    expect(resolveComputerGrants(null, undefined)).toBeUndefined();
  });

  it('defaults the device noun to This Mac in public error copy', () => {
    expect(
      publicErrorMessage(new ComputerBridgeError('x', 'authorization_failed')),
    ).toBe('This Mac does not have permission to read that local session.');
    expect(
      publicErrorMessage(new ComputerBridgeError('x', 'authorization_failed'), 'This iPhone'),
    ).toBe('This iPhone does not have permission to read that local session.');
    expect(publicErrorMessage(new ComputerBridgeError('x', 'invalid_response'))).toBe(
      'The paired local device returned an incompatible session history.',
    );
    expect(publicErrorMessage(new Error('boom'))).toBe(
      'The local session could not be loaded.',
    );
  });

  it('renders prompt error copy with device noun and computer name', () => {
    expect(promptErrorMessage(new ComputerBridgeError('x', 'busy'))).toBe(
      'Devin is finishing the previous turn. Try again in a moment.',
    );
    expect(promptErrorMessage(new ComputerBridgeError('x', 'authorization_failed'))).toBe(
      'This Mac is no longer authorized. Re-pair this local device in Settings.',
    );
    expect(promptErrorMessage(new ComputerBridgeError('x', 'permission_denied'))).toBe(
      'This Mac does not have permission to steer this session.',
    );
    expect(
      promptErrorMessage(new ComputerBridgeError('x', 'auto_approve_unavailable'), 'Work Mac'),
    ).toBe(
      "Auto-approve isn't allowed on Work Mac (organization policy). Your message wasn't sent.",
    );
    expect(promptErrorMessage(new Error('boom'))).toBe('The message could not be sent. Try again.');
  });

  it('renders discovery copy per state and null when ready', () => {
    const status = (state: ComputerDiscoveryStatus['state']): ComputerDiscoveryStatus => ({
      bridgeId: TEST_BRIDGE_ID,
      computerName: 'Mini',
      state,
    });
    expect(discoveryErrorCopy(status('ready'))).toBeNull();
    expect(discoveryErrorCopy(status('session_discovery_off'))).toContain(
      'Start its Connector with Devin ACP',
    );
    expect(discoveryErrorCopy(status('authorization_failed'))).toBe(
      'Mini needs to be paired again.',
    );
    expect(discoveryErrorCopy(status('too_many_sessions'))).toContain('more sessions than');
    expect(discoveryErrorCopy(status('invalid_response'))).toBe(
      'Mini returned an incompatible session response.',
    );
    expect(discoveryErrorCopy(status('busy'))).toContain('is busy');
    expect(discoveryErrorCopy(status('unavailable'))).toContain('offline');
  });

  it('renders local options failure copy with the device noun', () => {
    expect(localOptionsFailureCopy(new ComputerBridgeError('x', 'permission_denied'))).toEqual({
      title: 'Connector permission required',
      message:
        'Open Otterin Connector locally and enable Create new sessions for this Mac.',
    });
    expect(localOptionsFailureCopy(new Error('x')).title).toBe('Local options unavailable');
  });
});

describe('app-logic session detail helpers', () => {
  it('builds a devin reply signature and detects a settled new reply', () => {
    const session = {
      session: { id: 'local_x', origin: 'computer' as const, workspaceName: 'w' },
      messages: [
        { sequence: 1, source: 'user' as const, text: 'hi' },
        { sequence: 2, source: 'devin' as const, text: 'answer one' },
      ],
      truncated: false,
    };
    const signature = devinReplySignature(session);
    expect(signature).toBe(JSON.stringify(['answer one']));
    expect(devinReplySignature(undefined)).toBe('[]');
    expect(hasSettledNewDevinReply('[]', '["answer one"]', '["answer one"]')).toBe(true);
    expect(hasSettledNewDevinReply('[]', '["other"]', '["answer one"]')).toBe(false);
    expect(hasSettledNewDevinReply('["answer one"]', '["answer one"]', '["answer one"]')).toBe(
      false,
    );
  });

  it('summarizes an accepted elicitation response', () => {
    const summary = elicitationSummary(
      { interactionId: 'interaction_x', action: 'accept', content: { env: 'prod', ack: true } },
      {
        id: 'interaction_x',
        message: 'pick',
        createdAt: 1,
        fields: [
          {
            key: 'env',
            type: 'single_select',
            title: 'Env',
            required: true,
            options: [
              { value: 'prod', label: 'Production' },
              { value: 'dev', label: 'Dev' },
            ],
          },
          { key: 'ack', type: 'boolean', title: 'Ack', required: true },
        ],
      },
    );
    expect(summary).toBe('You answered · Production, Yes');
    expect(
      elicitationSummary({ interactionId: 'i', action: 'decline' }, null),
    ).toBe('You skipped this question');
  });
});

describe('app-logic model catalog', () => {
  it('splits model names into family and variant', () => {
    expect(splitComputerModelName('Claude Opus 4.5 High Thinking')).toEqual({
      family: 'Claude Opus 4.5',
      variant: 'High',
    });
    expect(splitComputerModelName('Claude Opus 4.5 No Thinking')).toEqual({
      family: 'Claude Opus 4.5',
      variant: 'None',
    });
    expect(splitComputerModelName('SWE-1.6 Lightning')).toEqual({
      family: 'SWE-1.6',
      variant: 'Lightning',
    });
    expect(splitComputerModelName('Claude Opus 4.5 Max 1M')).toEqual({
      family: 'Claude Opus 4.5',
      variant: 'Max · 1M',
    });
    expect(splitComputerModelName('Plain Model')).toEqual({
      family: 'Plain Model',
      variant: 'Default',
    });
  });

  it('groups variants under families and picks defaults', () => {
    const families = groupComputerModels([
      { id: 'a', name: 'Claude Opus 4.5 High Thinking', recommended: true },
      { id: 'b', name: 'Claude Opus 4.5 Medium Thinking' },
      { id: 'c', name: 'SWE-1.6 Fast', recent: true },
      { id: 'd', name: 'SWE-1.6 Lightning' },
    ]);
    expect(families.map((family) => family.name)).toEqual(['Claude Opus 4.5', 'SWE-1.6']);
    const opus = families[0]!;
    expect(opus.variants.map((variant) => variant.label)).toEqual(['High', 'Medium']);
    expect(familyForModelId(families, 'b')?.name).toBe('Claude Opus 4.5');
    expect(familyForModelId(families, null)?.name).toBe('Claude Opus 4.5');
    expect(preferredFamilyVariant(opus, 'b').model.id).toBe('b');
    expect(preferredFamilyVariant(families[1]!).model.id).toBe('c');
  });
});

describe('app-logic activity + time helpers', () => {
  it('labels activity kinds and statuses', () => {
    expect(activityShortLabel('editing')).toBe('Editing files');
    expect(activityShortLabel('thinking')).toBe('Thinking');
    expect(activityStatusLabel('awaiting_input')).toBe('Waiting for your answer');
    expect(activityStatusLabel('timed_out')).toBe('Timed out');
  });

  it('groups and summarizes activity entries', () => {
    const entries: ComputerActivityEntry[] = [
      { ...ACTIVITY_BASE, id: 't1', afterSequence: 1, toolKind: 'read' },
      { ...ACTIVITY_BASE, id: 't2', afterSequence: 1, toolKind: 'read' },
      { ...ACTIVITY_BASE, id: 't3', afterSequence: 3, kind: 'thought' },
      {
        ...ACTIVITY_BASE,
        id: 't4',
        afterSequence: 3,
        toolKind: 'execute',
        startedAt: 1_000,
        endedAt: 4_000,
      },
    ];
    const groups = groupActivity(entries);
    expect(groups.get(1)).toHaveLength(2);
    expect(groups.get(3)).toHaveLength(2);
    expect(summarizeActivity(entries)).toBe('Thought · Read 2 files · Ran 1 command · 3s');
    expect(activityGroupStatus(entries)).toBeNull();
    expect(activityGroupStatus([{ ...ACTIVITY_BASE, status: 'running' }])).toBe('running');
    expect(
      activityGroupStatus([
        { ...ACTIVITY_BASE, status: 'running' },
        { ...ACTIVITY_BASE, id: 't5', status: 'awaiting_input' },
      ]),
    ).toBe('awaiting_input');
  });

  it('renders relative and message time labels', () => {
    const now = 1_800_000_000;
    expect(formatRelativeTime(now - 30, now)).toBe('just now');
    expect(formatRelativeTime(now - 120, now)).toBe('2m ago');
    expect(formatRelativeTime(now - 7_200, now)).toBe('2h ago');
    expect(formatRelativeTime(now - 172_800, now)).toBe('2d ago');
    expect(sessionTimeLabel('not a date', now)).toBeNull();
    expect(sessionTimeLabel(undefined, now)).toBeNull();
    expect(sessionTimeLabel(new Date((now - 120) * 1_000).toISOString(), now)).toBe('2m ago');
  });

  it('emits day separators and per-message times', () => {
    const base = new Date();
    base.setHours(10, 0, 0, 0);
    const now = base.getTime();
    const labels = messageTimeLabels(
      [
        { source: 'user', createdAt: now - 3_600_000 },
        { source: 'user', createdAt: now - 3_500_000 },
        { source: 'devin', createdAt: now - 3_400_000 },
      ],
      now,
    );
    expect(labels[0]!.daySeparator).toBe('Today');
    expect(labels[0]!.time).toBeUndefined();
    expect(labels[1]!.time).toBeDefined();
    expect(labels[2]!.time).toBeDefined();
    expect(labels[2]!.daySeparator).toBeUndefined();
  });
});
