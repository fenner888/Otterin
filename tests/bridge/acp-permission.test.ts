import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AcpSessionClient,
  mapPermissionOptions,
  type AcpPermissionOption,
} from '../../bridge/src/acp';
import permissionOptionsFixture from './permission-options.fixture.json';

const SESSION_ID = 'session-interaction';
const permissionOptions = permissionOptionsFixture as AcpPermissionOption[];

describe('ACP permission prompts', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function fakeCli(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'devinx-acp-permission-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'devin');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
if (process.argv.length !== 3 || process.argv[2] !== 'acp') process.exit(2);
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8');
  const lines = input.split(/\\r?\\n/);
  input = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'authenticate') {
      process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result: {}}) + '\\n');
      continue;
    }
    ${body}
  }
});
`,
      { encoding: 'utf8' },
    );
    chmodSync(executable, 0o700);
    execFileSync(process.execPath, ['--check', executable]);
    return executable;
  }

  function permissionCli(
    options: readonly AcpPermissionOption[],
    result:
      | { outcome: 'selected'; optionId: string }
      | { outcome: 'cancelled' },
    extraRequests = '',
  ): string {
    const expectedOptionId = result.outcome === 'selected' ? result.optionId : undefined;
    return fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: '${SESSION_ID}', cwd: '/workspace' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  globalThis.promptRequestId = request.id;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: '${SESSION_ID}', update: {
      sessionUpdate: 'tool_call', toolCallId: 'tool-call-1', title: '  Ran \\n command  ',
      kind: 'execute', rawInput: { command: 'git status --short' },
      locations: [{ path: '/workspace/src/app.ts' }],
      _meta: { 'cognition.ai/inferenceToolName': 'exec' }
    }
  } }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'permission-request',
    method: 'session/request_permission', params: {
      sessionId: '${SESSION_ID}',
      toolCall: {
        toolCallId: 'tool-call-1',
        rawInput: { command: 'git status --short' },
        _meta: { 'cognition.ai/editableCommand': 'git status --short' }
      },
      options: ${JSON.stringify(options)}
    }
  }) + '\\n');
  ${extraRequests}
} else if (request.id === 'permission-request') {
  const outcome = request.result?.outcome;
  if (${JSON.stringify(result)}.outcome === 'cancelled') {
    if (outcome?.outcome !== 'cancelled') process.exit(41);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: '${SESSION_ID}', update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'permission-cancelled' }
      }
    } }) + '\\n');
    setTimeout(() => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: '${SESSION_ID}', update: {
          sessionUpdate: 'tool_call_update', toolCallId: 'tool-call-1', status: 'failed'
        }
      }
    }) + '\\n'), 50);
    setTimeout(() => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: '${SESSION_ID}', update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '|after-failed-update' }
        }
      }
    }) + '\\n'), 100);
    setTimeout(() => process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: globalThis.promptRequestId, result: { stopReason: 'end_turn' }
    }) + '\\n'), 500);
  } else if (outcome?.outcome !== 'selected' ||
             outcome.optionId !== ${JSON.stringify(expectedOptionId)}) {
    process.exit(42);
  } else {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: globalThis.promptRequestId, result: { stopReason: 'end_turn' }
    }) + '\\n');
  }
} else if (request.id === 'permission-duplicate' || request.id === 'permission-cross') {
  if (request.result?.outcome?.outcome !== 'cancelled') process.exit(43);
  globalThis.cancelledPermissionCount = (globalThis.cancelledPermissionCount || 0) + 1;
  if (globalThis.cancelledPermissionCount === 2) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: '${SESSION_ID}', update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'two-cancellations' }
      }
    } }) + '\\n');
  }
}`);
  }

  async function startPermissionClient(
    options: readonly AcpPermissionOption[],
    result: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' },
    configuration: { permissionTimeoutMs?: number; extraRequests?: string } = {},
  ): Promise<AcpSessionClient> {
    const client = new AcpSessionClient({
      executablePath: permissionCli(options, result, configuration.extraRequests),
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 5_000,
      permissionTimeoutMs: configuration.permissionTimeoutMs,
    });
    await client.start();
    await client.listSessions();
    await client.loadSession(SESSION_ID);
    await client.promptSession(SESSION_ID, 'Run the command.');
    return client;
  }

  async function waitForPermission(client: AcpSessionClient) {
    let permission = client.getPendingPermission(SESSION_ID);
    for (let attempt = 0; attempt < 100 && !permission; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      permission = client.getPendingPermission(SESSION_ID);
    }
    return permission;
  }

  it('maps the captured permission choices semantically, independent of position', () => {
    const expected = {
      allow_once: 'allow_once',
      allow_session: 'allow_session',
      reject_once: 'reject_once',
    };
    expect(mapPermissionOptions(permissionOptions)).toEqual(expected);
    expect(mapPermissionOptions([...permissionOptions].reverse())).toEqual(expected);
    expect(
      mapPermissionOptions(
        permissionOptions.filter(
          (option) =>
            option.optionId !== 'allow_once' &&
            option.optionId !== 'allow_session' &&
            option.optionId !== 'reject_once',
        ),
      ),
    ).toEqual({});
  });

  it('hides missing or ambiguous decisions and never exposes project/global/bypass choices', () => {
    expect(
      mapPermissionOptions([
        { optionId: 'a', kind: 'allow_once' },
        { optionId: 'b', kind: 'allow_once' },
        { optionId: 'allow_session', kind: 'allow_always', name: 'this session' },
        { optionId: 'another_session', kind: 'allow_always', name: 'this session' },
        { optionId: 'reject_once', kind: 'reject_once' },
        { optionId: 'global', kind: 'allow_always', name: 'all projects' },
        { optionId: 'bypass', kind: 'allow_always', name: 'switch to bypass mode' },
      ]),
    ).toEqual({ reject_once: 'reject_once' });
  });

  it('cancels an unrecognized permission instead of inferring by option position', async () => {
    const options = permissionOptions.map((option) => ({
      ...option,
      kind: 'other',
    }));
    const client = await startPermissionClient(options, { outcome: 'cancelled' });
    try {
      const pending = await waitForPermission(client);
      expect(pending).toBeNull();
      for (
        let attempt = 0;
        attempt < 100 &&
        !client.getSessionTurn(SESSION_ID)?.reply.includes('after-failed-update');
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(client.getSessionTurn(SESSION_ID)?.reply).toBe(
        'permission-cancelled|after-failed-update',
      );
    } finally {
      await client.stop();
    }
  });

  it('holds a bounded permission and sends the exact selected allow option', async () => {
    const client = await startPermissionClient(permissionOptions, {
      outcome: 'selected',
      optionId: 'allow_once',
    });
    try {
      const permission = await waitForPermission(client);
      expect(permission).toMatchObject({
        title: 'Ran command',
        toolKind: 'execute',
        command: 'git status --short',
        paths: ['src/app.ts'],
        decisions: ['allow_once', 'allow_session', 'reject_once'],
      });
      expect(permission?.expiresAt).toBeGreaterThan(permission?.createdAt ?? 0);
      expect(JSON.stringify(permission)).not.toContain('permission-request');
      expect(JSON.stringify(permission)).not.toContain('allow_always_global');
      expect(() =>
        client.respondToPermission(SESSION_ID, 'invalid-id', 'allow_once'),
      ).toThrow();
      expect(() =>
        client.respondToPermission(SESSION_ID, permission?.id, 'not-a-decision'),
      ).toThrow();
      client.respondToPermission(SESSION_ID, permission?.id, 'allow_once');
      expect(client.getPendingPermission(SESSION_ID)).toBeNull();
      expect(client.getSessionTurn(SESSION_ID)?.activity[0]?.status).toBe('running');
    } finally {
      await client.stop();
    }
  });

  it('sends the mapped reject option for a deny decision', async () => {
    const client = await startPermissionClient(permissionOptions, {
      outcome: 'selected',
      optionId: 'reject_once',
    });
    try {
      const permission = await waitForPermission(client);
      expect(permission?.decisions).toContain('reject_once');
      client.respondToPermission(SESSION_ID, permission?.id, 'reject_once');
    } finally {
      await client.stop();
    }
  });

  it('sends the mapped allow-for-this-session option', async () => {
    const client = await startPermissionClient(permissionOptions, {
      outcome: 'selected',
      optionId: 'allow_session',
    });
    try {
      const permission = await waitForPermission(client);
      client.respondToPermission(SESSION_ID, permission?.id, 'allow_session');
      expect(await client.getSessionActivity(SESSION_ID)).toMatchObject({
        label: 'Working on your task',
      });
    } finally {
      await client.stop();
    }
  });

  it('cancels duplicate and cross-session permission requests', async () => {
    const extraRequests = `
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'permission-duplicate',
    method: 'session/request_permission', params: {
      sessionId: '${SESSION_ID}', toolCall: { toolCallId: 'tool-call-2' },
      options: ${JSON.stringify(permissionOptions)}
    }
  }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'permission-cross',
    method: 'session/request_permission', params: {
      sessionId: 'other-session', toolCall: { toolCallId: 'tool-call-3' },
      options: ${JSON.stringify(permissionOptions)}
    }
  }) + '\\n');`;
    const client = await startPermissionClient(
      permissionOptions,
      { outcome: 'selected', optionId: 'allow_once' },
      { extraRequests },
    );
    try {
      const permission = await waitForPermission(client);
      expect(permission).not.toBeNull();
      for (let attempt = 0; attempt < 100 && !client.getSessionActivity; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      client.respondToPermission(SESSION_ID, permission?.id, 'allow_once');
    } finally {
      await client.stop();
    }
  });

  it('keeps the timed-out activity sticky while later chunks resume the response label', async () => {
    const client = await startPermissionClient(
      permissionOptions,
      { outcome: 'cancelled' },
      {
        permissionTimeoutMs: 1_000,
        extraRequests: 'setInterval(() => {}, 60_000);',
      },
    );
    try {
      expect(await waitForPermission(client)).not.toBeNull();
      for (
        let attempt = 0;
        attempt < 150 &&
        !client.getSessionTurn(SESSION_ID)?.reply.includes('after-failed-update');
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(client.getSessionTurn(SESSION_ID)?.reply).toBe(
        'permission-cancelled|after-failed-update',
      );
      expect((await client.getSessionActivity(SESSION_ID))?.label).toBe('Writing a response');
      expect(client.getPendingPermission(SESSION_ID)).toBeNull();
      expect(client.getSessionTurn(SESSION_ID)?.activity[0]).toMatchObject({
        status: 'timed_out',
      });
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if ((await client.getSessionActivity(SESSION_ID))?.active === false) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await client.getSessionActivity(SESSION_ID))?.active).toBe(false);
      expect([...client.getTimedOutToolCallIds(SESSION_ID)]).toEqual(['tool-call-1']);
      expect(client.getTimedOutToolCallIds('other-session').size).toBe(0);
    } finally {
      await client.stop();
    }
  });

  it('bounds timed-out call memory by session and per-session insertion order', async () => {
    type PendingPermissionState = {
      public: { id: string };
      toolCallId: string;
      timer: ReturnType<typeof setTimeout>;
    };
    type ClientState = {
      pendingPermissions: Map<string, PendingPermissionState>;
      timeOutPermission(sessionId: string, permissionId: string): void;
    };
    const createClient = () =>
      new AcpSessionClient({
        executablePath: process.execPath,
        requestTimeoutMs: 1_000,
        promptTimeoutMs: 5_000,
      });
    const timeOut = (
      state: ClientState,
      sessionId: string,
      toolCallId: string,
    ) => {
      const permissionId = `permission-${toolCallId}`;
      state.pendingPermissions.set(sessionId, {
        public: { id: permissionId },
        toolCallId,
        timer: setTimeout(() => {}, 60_000),
      });
      state.timeOutPermission(sessionId, permissionId);
    };
    const sessionClient = createClient();
    const sessionState = sessionClient as unknown as ClientState;
    try {
      for (let index = 0; index <= 100; index += 1) {
        timeOut(sessionState, `session-cap-${index}`, `call-${index}`);
      }
      expect(sessionClient.getTimedOutToolCallIds('session-cap-0').size).toBe(0);
      expect([...sessionClient.getTimedOutToolCallIds('session-cap-100')]).toEqual([
        'call-100',
      ]);
    } finally {
      await sessionClient.stop();
    }

    const callClient = createClient();
    const callState = callClient as unknown as ClientState;
    try {
      for (let index = 0; index <= 50; index += 1) {
        timeOut(callState, 'session-call-cap', `call-${index}`);
      }
      expect(callClient.getTimedOutToolCallIds('session-call-cap').size).toBe(50);
      expect(callClient.getTimedOutToolCallIds('session-call-cap').has('call-0')).toBe(false);
      expect(callClient.getTimedOutToolCallIds('session-call-cap').has('call-50')).toBe(true);
    } finally {
      await callClient.stop();
    }
  });

  async function startQuestionClient(allowOther: boolean): Promise<AcpSessionClient> {
    const expectedAnswer = allowOther ? 'Neither - just list the files' : 'first';
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: '${SESSION_ID}', cwd: '/workspace' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  globalThis.promptRequestId = request.id;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: '${SESSION_ID}', update: {
      sessionUpdate: 'tool_call', toolCallId: 'question-tool', title: 'Ask a question',
      kind: 'think', _meta: { 'cognition.ai/inferenceToolName': 'ask_user_question' }
    }
  } }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'question-request',
    method: 'elicitation/create', params: {
      mode: 'form', sessionId: '${SESSION_ID}', message: 'Which files should I list?',
      requestedSchema: { type: 'object', required: ['q0'], properties: { q0: {
        type: 'string', oneOf: [
          { const: 'first', title: 'First file' },
          { const: 'second', title: 'Second file' }
        ]
      } } },
      ${allowOther ? `_meta: { 'cognition.ai/allowOther': true },` : ''}
    }
  }) + '\\n');
} else if (request.id === 'question-request') {
  if (request.result?.action !== 'accept' ||
      request.result?.content?.q0 !== ${JSON.stringify(expectedAnswer)}) process.exit(44);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: '${SESSION_ID}', update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'question-tool', status: 'in_progress'
    }
  } }) + '\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: globalThis.promptRequestId, result: { stopReason: 'end_turn' }
  }) + '\\n'), 100);
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 5_000,
    });
    await client.start();
    await client.listSessions();
    await client.loadSession(SESSION_ID);
    await client.promptSession(SESSION_ID, 'List the files.');
    return client;
  }

  it('accepts trimmed free text only for negotiated single-select fields', async () => {
    const client = await startQuestionClient(true);
    try {
      let elicitation = client.getPendingElicitation(SESSION_ID);
      for (let attempt = 0; attempt < 100 && !elicitation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        elicitation = client.getPendingElicitation(SESSION_ID);
      }
      expect(elicitation?.fields[0]).toMatchObject({ type: 'single_select', allowOther: true });
      expect(client.getSessionTurn(SESSION_ID)?.activity[0]?.status).toBe('awaiting_input');
      client.respondToElicitation(SESSION_ID, elicitation?.id, {
        action: 'accept',
        content: { q0: '  Neither - just list the files  ' },
      });
      expect(client.getSessionTurn(SESSION_ID)?.activity[0]?.status).toBe('running');
    } finally {
      await client.stop();
    }
  });

  it('rejects free text when the request did not allow Other', async () => {
    const client = await startQuestionClient(false);
    try {
      let elicitation = client.getPendingElicitation(SESSION_ID);
      for (let attempt = 0; attempt < 100 && !elicitation; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        elicitation = client.getPendingElicitation(SESSION_ID);
      }
      expect(elicitation?.fields[0]?.allowOther).toBeUndefined();
      expect(() =>
        client.respondToElicitation(SESSION_ID, elicitation?.id, {
          action: 'accept',
          content: { q0: 'Neither option' },
        }),
      ).toThrow();
      client.respondToElicitation(SESSION_ID, elicitation?.id, {
        action: 'accept',
        content: { q0: 'first' },
      });
    } finally {
      await client.stop();
    }
  });
});
