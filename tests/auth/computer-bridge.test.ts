import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

const mockLoadPairedComputers = jest.fn();
const mockStorePairedComputers = jest.fn(async (_input: unknown) => {});
const mockCreateRequestIdentity = jest.fn();
const mockSign = jest.fn();
const mockPostPinnedBridgeJson = jest.fn();
const mockDeleteDeviceIdentity = jest.fn(async (_keyId: string) => {});

jest.mock('../../src/auth/pairedComputers', () => ({
  loadPairedComputers: () => mockLoadPairedComputers(),
  storePairedComputers: (input: unknown) => mockStorePairedComputers(input),
}));

jest.mock('../../src/auth/deviceSigning', () => ({
  createRequestIdentity: () => mockCreateRequestIdentity(),
  deleteDeviceIdentity: (keyId: string) => mockDeleteDeviceIdentity(keyId),
  sign: (keyId: string, message: string) => mockSign(keyId, message),
  postTailnetBridgeJson: (endpoint: string, path: string, body: unknown) =>
    mockPostPinnedBridgeJson(endpoint, path, body),
  postPinnedBridgeJson: (endpoint: string, path: string, fingerprint: string, body: unknown) =>
    mockPostPinnedBridgeJson(endpoint, path, fingerprint, body),
}));

import { canonicalJson } from '../../src/auth/canonicalJson';
import { FixedWindowRateLimiter } from '../../bridge/src/rate-limit';
import { InMemoryReplayGuard } from '../../bridge/src/replay';
import { BridgeService } from '../../bridge/src/service';
import { SessionHandleRegistry } from '../../bridge/src/session-handles';
import { WorkspaceHandleRegistry } from '../../bridge/src/workspace-handles';
import {
  ComputerBridgeError,
  cancelComputerSession,
  createComputerSession,
  disconnectComputer,
  getComputerBridgeFeatures,
  getComputerBridgeHealth,
  getComputerBridgePlatform,
  getComputerCreateOptions,
  listComputerSessions,
  loadComputerSession,
  openComputerBridge,
  openComputerBridges,
  promptComputerSession,
  respondToComputerSessionPermission,
  removeComputerFromThisIPhone,
} from '../../src/auth/computerBridge';

const NOW = 1_800_000_000_000;
const BRIDGE_ID = 'bridge_1234567890';
const DEVICE_ID = 'device_1234567890';
const KEY_ID = '3e399a5d-79c4-4a23-8aa7-a418565d974d';
const REQUEST_ID = 'd9428888-122b-11e1-b85c-61cd3cbb3210';
const NONCE = 'N'.repeat(32);
const SIGNATURE = 'S'.repeat(86);

const COMPUTER = {
  version: 3,
  bridgeId: BRIDGE_ID,
  computerName: 'Frank’s MacBook',
  endpoint: 'http://100.127.166.87:45831/',
  transportSecurity: 'tailscale_wireguard',
  tlsCertificateFingerprint: 'T'.repeat(43),
  bridgePublicKeySpki: 'B'.repeat(59),
  bridgeKeyFingerprint: 'F'.repeat(43),
  deviceId: DEVICE_ID,
  deviceKeyId: KEY_ID,
  devicePublicKeySpki: 'D'.repeat(59),
  permissions: ['bridge:health', 'session:metadata:read'],
  pairedAt: NOW - 60_000,
};

describe('authenticated mobile Computer Bridge client', () => {
  it('accepts the expanded model catalog and still rejects oversized catalogs', async () => {
    const options = (count: number) => ({
      workspaces: [],
      defaultModelId: 'model-0',
      catalogSource: 'live',
      models: Array.from({ length: count }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
        recent: false,
        recommended: index === 0,
      })),
    });
    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 200, body: options(385) });
    expect((await getComputerCreateOptions(BRIDGE_ID)).models).toHaveLength(385);
    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 200, body: options(1_001) });
    await expect(getComputerCreateOptions(BRIDGE_ID)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockLoadPairedComputers.mockResolvedValue([COMPUTER]);
    mockCreateRequestIdentity.mockResolvedValue({ requestId: REQUEST_ID, nonce: NONCE });
    mockSign.mockResolvedValue(SIGNATURE);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('signs a short-lived health envelope and sends it only through the Tailscale route', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({
      status: 200,
      body: {
        protocolVersion: 2,
        status: 'ready',
        capabilities: {
          sessionList: true,
          sessionLoad: false,
          sessionPrompt: false,
        },
      },
    });

    await expect(getComputerBridgeHealth(BRIDGE_ID)).resolves.toEqual({
      protocolVersion: 2,
      status: 'ready',
      capabilities: {
        sessionList: true,
        sessionLoad: false,
        sessionPrompt: false,
      },
    });

    expect(mockSign).toHaveBeenCalledTimes(1);
    const unsigned = JSON.parse(mockSign.mock.calls[0]?.[1] as string) as Record<string, unknown>;
    expect(mockSign).toHaveBeenCalledWith(KEY_ID, canonicalJson(unsigned));
    expect(unsigned).toEqual({
      body: {},
      bridgeId: BRIDGE_ID,
      deviceId: DEVICE_ID,
      expiresAt: NOW + 15_000,
      issuedAt: NOW,
      method: 'bridge.health',
      nonce: NONCE,
      protocolVersion: 2,
      requestId: REQUEST_ID,
    });
    expect(mockPostPinnedBridgeJson).toHaveBeenCalledWith(COMPUTER.endpoint, '/v1/request', {
      ...unsigned,
      signature: SIGNATURE,
    });
  });

  it('discovers structured question support without changing the health contract', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({
      status: 200,
      body: { sessionElicitation: true },
    });

    await expect(getComputerBridgeFeatures(BRIDGE_ID)).resolves.toEqual({
      sessionElicitation: true,
      activityTimeline: false,
    });
  });

  it('fails closed when an older Connector does not implement the feature handshake', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({ status: 400, body: {} });

    await expect(getComputerBridgeFeatures(BRIDGE_ID)).resolves.toEqual({
      sessionElicitation: false,
      activityTimeline: false,
    });
  });

  it('refreshes sessions when content access is granted after pairing', async () => {
    const keys = generateKeyPairSync('ed25519');
    const publicKeySpki = keys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64url');
    mockLoadPairedComputers.mockResolvedValue([
      { ...COMPUTER, devicePublicKeySpki: publicKeySpki },
    ]);
    mockSign.mockImplementation(async (_keyId: string, message: string) =>
      nodeSign(null, Buffer.from(message, 'utf8'), keys.privateKey).toString('base64url'),
    );
    const sessionHandles = new SessionHandleRegistry(BRIDGE_ID, Buffer.alloc(32, 7));
    let allowContent = false;
    let requestNumber = 0;
    mockCreateRequestIdentity.mockImplementation(async () => ({
      requestId: `d9428888-122b-11e1-b85c-${String(++requestNumber).padStart(12, '0')}`,
      nonce: String(requestNumber).padStart(32, 'N'),
    }));
    const service = new BridgeService({
      bridgeId: BRIDGE_ID,
      platform: 'windows',
      devices: {
        get: (deviceId) =>
          deviceId === DEVICE_ID
            ? {
                bridgeId: BRIDGE_ID,
                deviceId: DEVICE_ID,
                deviceName: 'Frank’s iPhone',
                publicKeySpki,
                status: 'active',
                pairedAt: NOW - 60_000,
                permissions: [
                  'bridge:health',
                  'session:metadata:read',
                  ...(allowContent ? (['session:content:read'] as const) : []),
                ],
              }
            : undefined,
      },
      replayGuard: new InMemoryReplayGuard(),
      rateLimiter: new FixedWindowRateLimiter(),
      sessionHandles,
      workspaceHandles: new WorkspaceHandleRegistry(BRIDGE_ID, Buffer.alloc(32, 8)),
      sessions: {
        isSessionListSupported: () => true,
        listSessions: async () => ({
          sessions: [{ sessionId: 'acp-session', cwd: '/repo', title: 'Review changes' }],
        }),
        isSessionLoadSupported: () => true,
        loadSession: async () => ({
          sessionId: 'acp-session',
          cwd: '/repo',
          messages: [],
          truncated: false,
        }),
        isSessionPromptSupported: () => true,
        promptSession: async () => {},
      },
    });
    mockPostPinnedBridgeJson.mockImplementation(
      async (_endpoint: string, _path: string, envelope: unknown) => {
        const response = await service.handle(envelope, { peerKey: 'phone', now: NOW });
        return { status: response.status, body: response.body };
      },
    );

    await expect(getComputerBridgeHealth(BRIDGE_ID)).resolves.toMatchObject({
      status: 'ready',
      capabilities: { sessionList: true, sessionLoad: false },
    });
    const redacted = await listComputerSessions(BRIDGE_ID);
    expect(redacted.sessions).toHaveLength(1);
    const session = redacted.sessions[0];
    if (!session) throw new Error('Expected the listed session');
    expect(session.title).toBeUndefined();

    allowContent = true;
    await expect(getComputerBridgeHealth(BRIDGE_ID)).resolves.toMatchObject({
      capabilities: { sessionLoad: true },
    });
    await expect(listComputerSessions(BRIDGE_ID)).resolves.toMatchObject({
      sessions: [{ id: session.id, title: 'Review changes' }],
    });
    await expect(loadComputerSession(BRIDGE_ID, session.id)).resolves.toMatchObject({
      messages: [],
    });

    allowContent = false;
    await expect(listComputerSessions(BRIDGE_ID)).resolves.toEqual(redacted);
    await expect(loadComputerSession(BRIDGE_ID, session.id)).rejects.toMatchObject({
      code: 'authorization_failed',
    });
    expect(mockStorePairedComputers).not.toHaveBeenCalled();
    sessionHandles.destroy();
  });

  it('discovers the signed connector platform and safely falls back for legacy connectors', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: { platform: 'windows' },
    });
    await expect(getComputerBridgePlatform(BRIDGE_ID)).resolves.toBe('windows');

    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 400, body: {} });
    await expect(getComputerBridgePlatform(BRIDGE_ID)).resolves.toBe('unknown');
  });

  it('validates a privacy-redacted local session page and optional cursor', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({
      status: 200,
      body: {
        sessions: [
          {
            id: `local_${'L'.repeat(43)}`,
            origin: 'computer',
            workspaceName: 'DevinX',
            hasTitle: true,
            updatedAt: '2027-01-15T12:00:00.000Z',
          },
        ],
        nextCursor: 'next-page',
      },
    });

    await expect(listComputerSessions(BRIDGE_ID, { cursor: 'current-page' })).resolves.toEqual({
      sessions: [
        {
          id: `local_${'L'.repeat(43)}`,
          origin: 'computer',
          workspaceName: 'DevinX',
          hasTitle: true,
          updatedAt: '2027-01-15T12:00:00.000Z',
        },
      ],
      nextCursor: 'next-page',
    });
    const envelope = mockPostPinnedBridgeJson.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(envelope).toMatchObject({ method: 'session.list', body: { cursor: 'current-page' } });
  });

  it('signs a content-gated load request and validates minimized history', async () => {
    const sessionId = `local_${'L'.repeat(43)}`;
    mockLoadPairedComputers.mockResolvedValue([
      { ...COMPUTER, permissions: [...COMPUTER.permissions, 'session:content:read'] },
    ]);
    mockPostPinnedBridgeJson.mockResolvedValue({
      status: 200,
      body: {
        session: { id: sessionId, origin: 'computer', workspaceName: 'DevinX' },
        messages: [
          { sequence: 1, source: 'user', text: 'Review this.' },
          { sequence: 2, source: 'devin', text: 'Review complete.' },
        ],
        truncated: false,
      },
    });

    await expect(loadComputerSession(BRIDGE_ID, sessionId)).resolves.toMatchObject({
      session: { id: sessionId, workspaceName: 'DevinX' },
      messages: [{ source: 'user' }, { source: 'devin' }],
    });
    expect(mockPostPinnedBridgeJson.mock.calls[0]?.[2]).toMatchObject({
      method: 'session.load',
      body: { sessionId },
    });
  });

  it('sends steering to the authoritative Mac even when the cached pairing grant is stale', async () => {
    const sessionId = `local_${'P'.repeat(43)}`;
    mockPostPinnedBridgeJson.mockResolvedValue({ status: 200, body: { accepted: true } });

    await expect(
      promptComputerSession(BRIDGE_ID, sessionId, 'Continue the task.', 'swe-1.7-high'),
    ).resolves.toBeUndefined();
    expect(mockPostPinnedBridgeJson.mock.calls[0]?.[2]).toMatchObject({
      method: 'session.prompt',
      body: { sessionId, text: 'Continue the task.', modelId: 'swe-1.7-high' },
    });
    expect((mockPostPinnedBridgeJson.mock.calls[0]?.[2] as { body: object }).body).not.toHaveProperty(
      'autoApprove',
    );
  });

  it('sends an explicitly disabled auto-approve value and maps policy rejection', async () => {
    const sessionId = `local_${'P'.repeat(43)}`;
    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 200, body: { accepted: true } });
    await expect(
      promptComputerSession(BRIDGE_ID, sessionId, 'Continue.', undefined, false),
    ).resolves.toBeUndefined();
    expect(mockPostPinnedBridgeJson.mock.calls[0]?.[2]).toMatchObject({
      method: 'session.prompt',
      body: { sessionId, autoApprove: false },
    });

    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 409,
      body: { error: 'auto_approve_unavailable' },
    });
    await expect(
      promptComputerSession(BRIDGE_ID, sessionId, 'Continue.', undefined, true),
    ).rejects.toMatchObject({ code: 'auto_approve_unavailable' });
  });

  it('signs session cancellation and validates its success response', async () => {
    const sessionId = `local_${'C'.repeat(43)}`;
    mockLoadPairedComputers.mockResolvedValue([
      { ...COMPUTER, permissions: [...COMPUTER.permissions, 'session:content:read'] },
    ]);
    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 200, body: { cancelled: true } });
    await expect(cancelComputerSession(BRIDGE_ID, sessionId)).resolves.toBeUndefined();
    expect(mockCreateRequestIdentity).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockPostPinnedBridgeJson.mock.calls[0]?.[2]).toMatchObject({
      method: 'session.cancel',
      body: { sessionId },
    });

    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 200, body: { cancelled: false } });
    await expect(cancelComputerSession(BRIDGE_ID, sessionId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('sends approval decisions when the paired send grant is stale', async () => {
    const sessionId = `local_${'P'.repeat(43)}`;
    const permissionId = `permission_${'P'.repeat(43)}`;
    mockLoadPairedComputers.mockResolvedValue([
      { ...COMPUTER, permissions: [...COMPUTER.permissions, 'session:content:read'] },
    ]);
    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 200, body: { accepted: true } });

    await expect(
      respondToComputerSessionPermission(BRIDGE_ID, {
        sessionId,
        permissionId,
        decision: 'allow_once',
      }),
    ).resolves.toBeUndefined();

    expect(mockCreateRequestIdentity).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockPostPinnedBridgeJson.mock.calls[0]?.[2]).toMatchObject({
      method: 'session.permission.respond',
      body: { sessionId, permissionId, decision: 'allow_once' },
    });
  });

  it('returns a validated continuation handle from the authoritative Mac', async () => {
    const sessionId = `local_${'P'.repeat(43)}`;
    const continuedSessionId = `local_${'C'.repeat(43)}`;
    mockPostPinnedBridgeJson.mockResolvedValue({
      status: 200,
      body: { accepted: true, sessionId: continuedSessionId },
    });

    await expect(
      promptComputerSession(BRIDGE_ID, sessionId, 'Continue the task.'),
    ).resolves.toEqual({ sessionId: continuedSessionId });
  });

  it('validates local creation options and lets the Mac authorize creation authoritatively', async () => {
    const workspaceId = `workspace_${'W'.repeat(43)}`;
    const sessionId = `local_${'C'.repeat(43)}`;
    mockPostPinnedBridgeJson
      .mockResolvedValueOnce({
        status: 200,
        body: {
          workspaces: [{ id: workspaceId, name: 'DevinX' }],
          models: [{ id: 'gpt-5-6-sol-medium', name: 'GPT 5.6 Sol Medium' }],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { accepted: true, sessionId },
      });

    await expect(getComputerCreateOptions(BRIDGE_ID)).resolves.toEqual({
      workspaces: [{ id: workspaceId, name: 'DevinX' }],
      models: [
        {
          id: 'gpt-5-6-sol-medium',
          name: 'GPT 5.6 Sol Medium',
          recent: false,
          recommended: false,
        },
      ],
      defaultModelId: null,
      catalogSource: 'recent',
    });
    await expect(
      createComputerSession(BRIDGE_ID, {
        workspaceId,
        modelId: 'gpt-5-6-sol-medium',
        text: 'Build this.',
      }),
    ).resolves.toEqual({ sessionId });
    expect(mockPostPinnedBridgeJson.mock.calls[1]?.[2]).toMatchObject({
      method: 'session.create',
      body: { workspaceId, modelId: 'gpt-5-6-sol-medium', text: 'Build this.' },
    });
    expect((mockPostPinnedBridgeJson.mock.calls[1]?.[2] as { body: object }).body).not.toHaveProperty(
      'autoApprove',
    );

    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: { accepted: true, sessionId },
    });
    await expect(
      createComputerSession(BRIDGE_ID, {
        workspaceId,
        text: 'Build this safely.',
        autoApprove: false,
      }),
    ).resolves.toEqual({ sessionId });
    expect(mockPostPinnedBridgeJson.mock.calls[2]?.[2]).toMatchObject({
      method: 'session.create',
      body: { workspaceId, text: 'Build this safely.', autoApprove: false },
    });
  });

  it('requests a forced local model-catalog refresh without accepting client catalog input', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: {
        workspaces: [],
        models: [{ id: 'swe-1.8', name: 'SWE-1.8', recent: false, recommended: true }],
        defaultModelId: 'swe-1.8',
        catalogSource: 'live',
      },
    });

    await expect(getComputerCreateOptions(BRIDGE_ID, true)).resolves.toMatchObject({
      models: [{ id: 'swe-1.8', name: 'SWE-1.8' }],
      defaultModelId: 'swe-1.8',
      catalogSource: 'live',
    });
    expect(mockPostPinnedBridgeJson.mock.calls[0]?.[2]).toMatchObject({
      method: 'session.create_options',
      body: { refresh: true },
    });
  });

  it('revokes on the Mac before removing the local computer credential', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({ status: 200, body: { revoked: true } });

    await expect(disconnectComputer(BRIDGE_ID)).resolves.toBeUndefined();
    expect(mockPostPinnedBridgeJson.mock.calls[0]?.[2]).toMatchObject({
      method: 'device.revoke',
      body: {},
    });
    expect(mockStorePairedComputers).toHaveBeenCalledWith([]);
    expect(mockDeleteDeviceIdentity).toHaveBeenCalledWith(KEY_ID);
  });

  it('finishes local cleanup when the Mac already revoked the device', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({ status: 404, body: { error: 'not_found' } });

    await expect(disconnectComputer(BRIDGE_ID)).resolves.toBeUndefined();
    expect(mockStorePairedComputers).toHaveBeenCalledWith([]);
    expect(mockDeleteDeviceIdentity).toHaveBeenCalledWith(KEY_ID);
  });

  it('preserves the local credential when secure revocation has an availability failure', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({
      status: 503,
      body: { error: 'temporarily_unavailable' },
    });

    await expect(disconnectComputer(BRIDGE_ID)).rejects.toMatchObject({ code: 'unavailable' });
    expect(mockStorePairedComputers).not.toHaveBeenCalled();
    expect(mockDeleteDeviceIdentity).not.toHaveBeenCalled();
  });

  it('classifies Connector conflicts without retrying the prompt', async () => {
    mockLoadPairedComputers.mockResolvedValue([
      { ...COMPUTER, permissions: [...COMPUTER.permissions, 'session:prompt:send'] },
    ]);
    mockPostPinnedBridgeJson.mockResolvedValue({ status: 409, body: { error: 'conflict' } });

    await expect(
      promptComputerSession(BRIDGE_ID, `local_${'L'.repeat(43)}`, 'Continue.'),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(mockPostPinnedBridgeJson).toHaveBeenCalledTimes(1);
  });

  it('can remove the local pairing without claiming or attempting Mac revocation', async () => {
    await expect(removeComputerFromThisIPhone(BRIDGE_ID)).resolves.toBeUndefined();

    expect(mockPostPinnedBridgeJson).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockStorePairedComputers).toHaveBeenCalledWith([]);
    expect(mockDeleteDeviceIdentity).toHaveBeenCalledWith(KEY_ID);
  });

  it('fails local history closed for server-denied grants, handle mismatch, or invalid sequence', async () => {
    const sessionId = `local_${'L'.repeat(43)}`;
    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 404, body: { error: 'not_found' } });
    await expect(loadComputerSession(BRIDGE_ID, sessionId)).rejects.toMatchObject({
      code: 'authorization_failed',
    });
    expect(mockSign).toHaveBeenCalledTimes(1);

    mockLoadPairedComputers.mockResolvedValue([
      { ...COMPUTER, permissions: [...COMPUTER.permissions, 'session:content:read'] },
    ]);
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: {
        session: {
          id: `local_${'M'.repeat(43)}`,
          origin: 'computer',
          workspaceName: 'DevinX',
        },
        messages: [],
        truncated: false,
      },
    });
    await expect(loadComputerSession(BRIDGE_ID, sessionId)).rejects.toMatchObject({
      code: 'invalid_response',
    });

    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: {
        session: { id: sessionId, origin: 'computer', workspaceName: 'DevinX' },
        messages: [{ sequence: 2, source: 'devin', text: 'Out of sequence' }],
        truncated: false,
      },
    });
    await expect(loadComputerSession(BRIDGE_ID, sessionId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('validates the Keychain credential once for a multi-request discovery cycle', async () => {
    mockPostPinnedBridgeJson
      .mockResolvedValueOnce({
        status: 200,
        body: {
          protocolVersion: 2,
          status: 'ready',
          capabilities: {
            sessionList: true,
            sessionLoad: false,
            sessionPrompt: false,
          },
        },
      })
      .mockResolvedValueOnce({ status: 200, body: { sessions: [] } });

    const connection = await openComputerBridge(BRIDGE_ID);
    await connection.getHealth();
    await connection.listSessions();

    expect(mockLoadPairedComputers).toHaveBeenCalledTimes(1);
    expect(mockCreateRequestIdentity).toHaveBeenCalledTimes(2);
    expect(mockSign).toHaveBeenCalledTimes(2);
  });

  it('validates Connector version information and treats an unsupported method as legacy', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: { version: '0.1.2' },
    });

    const connection = await openComputerBridge(BRIDGE_ID);
    await expect(connection.getVersion()).resolves.toEqual({ kind: 'supported', version: '0.1.2' });

    mockPostPinnedBridgeJson.mockResolvedValueOnce({ status: 400, body: { error: 'invalid' } });
    await expect(connection.getVersion()).resolves.toEqual({ kind: 'legacy' });
  });

  it('opens all selected paired Macs from one validated credential-registry read', async () => {
    const second = {
      ...COMPUTER,
      bridgeId: 'bridge_0987654321',
      deviceId: 'device_0987654321',
    };
    mockLoadPairedComputers.mockResolvedValue([COMPUTER, second]);

    const connections = await openComputerBridges([COMPUTER.bridgeId, second.bridgeId]);

    expect(connections.get(COMPUTER.bridgeId)?.bridgeId).toBe(COMPUTER.bridgeId);
    expect(connections.get(second.bridgeId)?.bridgeId).toBe(second.bridgeId);
    expect(mockLoadPairedComputers).toHaveBeenCalledTimes(1);
  });

  it('fails before signing when the local grant is absent', async () => {
    mockLoadPairedComputers.mockResolvedValue([{ ...COMPUTER, permissions: ['bridge:health'] }]);

    await expect(listComputerSessions(BRIDGE_ID)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(mockCreateRequestIdentity).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockPostPinnedBridgeJson).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'authorization_failed'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
    [400, 'invalid_response'],
  ])('maps status %s without exposing server details', async (status, code) => {
    mockPostPinnedBridgeJson.mockResolvedValue({ status, body: { error: 'private_detail' } });

    const request = getComputerBridgeHealth(BRIDGE_ID);
    await expect(request).rejects.toBeInstanceOf(ComputerBridgeError);
    await expect(request).rejects.toMatchObject({ code });
  });

  it('distinguishes Connector read contention from request-rate limiting', async () => {
    mockPostPinnedBridgeJson.mockResolvedValue({ status: 429, body: { error: 'busy' } });

    await expect(getComputerBridgeHealth(BRIDGE_ID)).rejects.toMatchObject({ code: 'busy' });
    expect(mockPostPinnedBridgeJson).toHaveBeenCalledTimes(1);
  });

  it('fails closed on malformed response fields, duplicate sessions, or transport errors', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: {
        sessions: [
          {
            id: `local_${'L'.repeat(43)}`,
            origin: 'computer',
            workspaceName: 'Repo',
            hasTitle: false,
            title: 'Leaked title',
          },
        ],
      },
    });
    await expect(listComputerSessions(BRIDGE_ID)).rejects.toMatchObject({
      code: 'invalid_response',
    });

    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: {
        sessions: [
          {
            id: `local_${'M'.repeat(43)}`,
            origin: 'computer',
            workspaceName: 'Repo',
            hasTitle: true,
            title: 'Valid title',
          },
          {
            id: `local_${'M'.repeat(43)}`,
            origin: 'computer',
            workspaceName: 'Repo',
            hasTitle: false,
          },
        ],
      },
    });
    await expect(listComputerSessions(BRIDGE_ID)).rejects.toMatchObject({
      code: 'invalid_response',
    });

    mockPostPinnedBridgeJson.mockRejectedValueOnce(new Error('certificate mismatch details'));
    await expect(getComputerBridgeHealth(BRIDGE_ID)).rejects.toEqual(
      expect.objectContaining({
        code: 'unavailable',
        message: 'The paired local device could not be reached securely.',
      }),
    );
  });
});

describe('computer bridge activity timeline schemas', () => {
  const sessionId = `local_${'L'.repeat(43)}`;
  const contentComputer = {
    ...COMPUTER,
    permissions: [...COMPUTER.permissions, 'session:content:read'],
  };
  const loadedBody = (overrides: Record<string, unknown> = {}) => ({
    session: { id: sessionId, origin: 'computer', workspaceName: 'Repo' },
    messages: [{ sequence: 1, source: 'devin', text: 'Ready.' }],
    truncated: false,
    ...overrides,
  });
  const activityEntry = (overrides: Record<string, unknown> = {}) => ({
    id: 'tool_abc',
    afterSequence: 1,
    kind: 'tool',
    toolKind: 'read',
    status: 'completed',
    title: 'Read file',
    truncated: false,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockLoadPairedComputers.mockResolvedValue([contentComputer]);
    mockCreateRequestIdentity.mockResolvedValue({ requestId: REQUEST_ID, nonce: NONCE });
    mockSign.mockResolvedValue(SIGNATURE);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses a legacy features response that omits activityTimeline', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: { sessionElicitation: true },
    });
    await expect(getComputerBridgeFeatures(BRIDGE_ID)).resolves.toEqual({
      sessionElicitation: true,
      activityTimeline: false,
    });
  });

  it('accepts a loaded session with well-formed activity entries', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: loadedBody({
        activity: [
          activityEntry({ paths: ['notes.txt'], detail: { type: 'text', text: 'output' } }),
        ],
      }),
    });
    await expect(loadComputerSession(BRIDGE_ID, sessionId)).resolves.toMatchObject({
      activity: [{ id: 'tool_abc', paths: ['notes.txt'] }],
    });
  });

  it('rejects activity entries with absolute paths', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: loadedBody({
        activity: [activityEntry({ paths: ['/Users/frank/secret.txt'] })],
      }),
    });
    await expect(loadComputerSession(BRIDGE_ID, sessionId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects activity afterSequence beyond the returned messages', async () => {
    mockPostPinnedBridgeJson.mockResolvedValueOnce({
      status: 200,
      body: loadedBody({ activity: [activityEntry({ afterSequence: 2 })] }),
    });
    await expect(loadComputerSession(BRIDGE_ID, sessionId)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
