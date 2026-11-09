import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AcpAutoApproveUnavailableError,
  AcpBusyError,
  acpWorkingDirectory,
  AcpSessionClient,
  isAcpSessionInUseError,
  listDevinCliModelCatalog,
  parseAcpModelCatalog,
  parseDevinCliModelCatalog,
  safeAcpChildEnvironment,
} from '../../bridge/src/acp';

describe('ACP session client', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    delete process.env.DEVINX_TEST_SECRET;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function fakeCli(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'devinx-acp-client-'));
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

  it('uses an allowlisted Windows user environment without forwarding unrelated values', () => {
    const environment = safeAcpChildEnvironment({
      NODE_ENV: 'production',
      USERPROFILE: 'C:\\Users\\tester',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      DEVINX_TEST_SECRET: 'must-not-forward',
    });

    expect(environment).toEqual({
      NODE_ENV: 'production',
      NO_COLOR: '1',
      LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\tester',
    });
    expect(environment.DEVINX_TEST_SECRET).toBeUndefined();
  });

  it('imports windsurf_api_key from the Devin credentials file when unset', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'devinx-creds-'));
    mkdirSync(join(dataHome, 'devin'), { recursive: true });
    writeFileSync(
      join(dataHome, 'devin', 'credentials.toml'),
      'windsurf_api_key = "test-key_123"\napi_server_url = "https://example.test"\n',
    );
    try {
      const environment = safeAcpChildEnvironment({
        NODE_ENV: 'test',
        XDG_DATA_HOME: dataHome,
        DEVINX_TEST_SECRET: 'must-not-forward',
      });
      expect(environment.WINDSURF_API_KEY).toBe('test-key_123');
      expect(environment.DEVINX_TEST_SECRET).toBeUndefined();
    } finally {
      rmSync(dataHome, { recursive: true, force: true });
    }
  });

  it('keeps an explicit WINDSURF_API_KEY over the credentials file', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'devinx-creds-'));
    mkdirSync(join(dataHome, 'devin'), { recursive: true });
    writeFileSync(
      join(dataHome, 'devin', 'credentials.toml'),
      'windsurf_api_key = "file-key"\n',
    );
    try {
      const environment = safeAcpChildEnvironment({
        NODE_ENV: 'test',
        XDG_DATA_HOME: dataHome,
        WINDSURF_API_KEY: 'env-key',
      });
      expect(environment.WINDSURF_API_KEY).toBe('env-key');
    } finally {
      rmSync(dataHome, { recursive: true, force: true });
    }
  });

  it('uses USERPROFILE when a Windows ACP process has no HOME', () => {
    if (process.platform === 'win32') {
      expect(
        acpWorkingDirectory({
          NODE_ENV: 'test',
          USERPROFILE: 'C:\\Users\\tester',
        }),
      ).toBe('C:\\Users\\tester');
      return;
    }
    expect(
      acpWorkingDirectory({
        HOME: '/Users/tester',
        NODE_ENV: 'test',
      }),
    ).toBe('/Users/tester');
  });

  it('parses the bounded account-scoped Devin CLI model catalog', () => {
    expect(
      parseDevinCliModelCatalog(
        {
          families: [
            {
              family_label: 'Claude Opus 5',
              variants: [
                {
                  model_uid: 'claude-opus-5-medium',
                  label: 'Claude Opus 5 Medium',
                  description: 'Balanced reasoning',
                  is_new: true,
                  cost_summary: '$2 / MTok In · $8 / MTok Out',
                  cost_tier: 'High cost',
                },
              ],
            },
            {
              family_label: 'Adaptive',
              variants: [{ model_uid: 'adaptive', label: 'Adaptive', is_new: false }],
            },
          ],
        },
        'claude-opus-5-medium',
      ),
    ).toEqual({
      defaultModelId: 'claude-opus-5-medium',
      models: [
        {
          id: 'claude-opus-5-medium',
          name: 'Claude Opus 5 Medium',
          description: 'Balanced reasoning',
          badge: 'new',
          costTier: 'high',
          costSummary: '$2 / MTok In · $8 / MTok Out',
        },
        { id: 'adaptive', name: 'Adaptive' },
      ],
    });
  });

  it('ignores future cost tiers and safely bounds display-only cost summaries', () => {
    const summary = `Variable\n${'x'.repeat(240)}`;
    const catalog = parseDevinCliModelCatalog({
      families: [
        {
          variants: [
            {
              model_uid: 'future-model',
              label: 'Future Model',
              cost_tier: 'Future tier',
              cost_summary: summary,
            },
          ],
        },
      ],
    });

    expect(catalog.models).toEqual([
      {
        id: 'future-model',
        name: 'Future Model',
        costSummary: `Variable ${'x'.repeat(191)}`,
      },
    ]);
  });

  it('loads the model catalog through the Devin CLI machine-readable command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'devinx-model-catalog-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'devin');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'models list --format json') process.exit(2);
process.stdout.write(JSON.stringify({
  families: [
    { variants: [{ model_uid: 'adaptive', label: 'Adaptive', is_new: false }] },
    { variants: [{ model_uid: 'swe-1-8', label: 'SWE-1.8', is_new: true }] }
  ]
}));
`,
      { encoding: 'utf8' },
    );
    chmodSync(executable, 0o700);

    await expect(listDevinCliModelCatalog(executable)).resolves.toEqual({
      defaultModelId: 'adaptive',
      models: [
        { id: 'adaptive', name: 'Adaptive' },
        { id: 'swe-1-8', name: 'SWE-1.8', badge: 'new' },
      ],
    });
  });

  it('rejects duplicate model IDs from the Devin CLI catalog', () => {
    expect(() =>
      parseDevinCliModelCatalog({
        families: [
          { variants: [{ model_uid: 'adaptive', label: 'Adaptive', is_new: false }] },
          { variants: [{ model_uid: 'adaptive', label: 'Adaptive duplicate', is_new: false }] },
        ],
      }),
    ).toThrow('duplicate IDs');
  });

  it('accepts the growing live catalog while enforcing a bounded model limit', () => {
    const catalog = (count: number) => ({
      families: [
        {
          variants: Array.from({ length: count }, (_, index) => ({
            model_uid: `model-${index}`,
            label: `Model ${index}`,
            is_new: false,
          })),
        },
      ],
    });
    expect(parseDevinCliModelCatalog(catalog(385)).models).toHaveLength(385);
    expect(parseDevinCliModelCatalog(catalog(1_000)).models).toHaveLength(1_000);
    expect(() => parseDevinCliModelCatalog(catalog(1_001))).toThrow();
  });

  it('loads models on a cold start without loading, creating, or locking a session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'devinx-cold-models-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'devin');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'models list --format json') {
  process.stdout.write(JSON.stringify({families:[{variants:[{model_uid:'adaptive',label:'Adaptive',is_new:false}]}]}));
} else {
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (request.method === 'authenticate') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}})+'\\n');
        continue;
      }
      if (request.method !== 'initialize') process.exit(29);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');
    }
  });
}
`,
    );
    chmodSync(executable, 0o700);
    const client = new AcpSessionClient({ executablePath: executable });
    try {
      await client.start();
      expect((await client.listModelCatalog()).models).toEqual([
        { id: 'adaptive', name: 'Adaptive' },
      ]);
      expect((await client.listModelCatalog()).models).toHaveLength(1);
    } finally {
      await client.stop();
    }
  });

  it('rejects oversized Devin CLI catalog output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'devinx-model-catalog-oversized-'));
    temporaryDirectories.push(directory);
    const executable = join(directory, 'devin');
    writeFileSync(
      executable,
      `#!/usr/bin/env node
process.stdout.write(' '.repeat(1024 * 1024 + 1));
`,
      { encoding: 'utf8' },
    );
    chmodSync(executable, 0o700);

    await expect(listDevinCliModelCatalog(executable)).rejects.toThrow('size limit');
  });

  it('initializes, capability-gates, and returns minimized validated session metadata', async () => {
    process.env.DEVINX_TEST_SECRET = 'must-not-forward';
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { list: {} } },
      _meta: { privateInitialization: 'drop-me' }
    }
  }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      sessions: [{
        sessionId: 'session-123',
        cwd: '/Users/example/project',
        additionalDirectories: ['/Users/example/shared'],
        title: process.env.DEVINX_TEST_SECRET ||
          (process.cwd() === process.env.HOME ? 'safe-title' : 'wrong-working-directory'),
        updatedAt: '2026-07-10T12:00:00Z',
        privateExtension: 'drop-extension-value',
        _meta: { privateToken: 'drop-metadata-value' }
      }],
      nextCursor: request.params.cursor ? undefined : 'opaque-next-cursor',
      privateResponse: 'drop-response-value'
    }
  }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      const page = await client.listSessions({});
      expect(page).toEqual({
        sessions: [
          {
            sessionId: 'session-123',
            cwd: '/Users/example/project',
            additionalDirectories: ['/Users/example/shared'],
            title: 'safe-title',
            updatedAt: '2026-07-10T12:00:00Z',
          },
        ],
        nextCursor: 'opaque-next-cursor',
      });
      expect(JSON.stringify(page)).not.toContain('drop-extension-value');
      expect(JSON.stringify(page)).not.toContain('drop-metadata-value');
      expect(JSON.stringify(page)).not.toContain('drop-response-value');
      expect(JSON.stringify(page)).not.toContain('must-not-forward');
    } finally {
      await client.stop();
    }
  });

  it('never sends session/list when the capability is absent', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: { protocolVersion: 1, agentCapabilities: {} }
  }) + '\\n');
} else if (request.method === 'session/list') {
  process.exit(9);
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await expect(client.listSessions()).rejects.toThrow('does not support session listing');
    } finally {
      await client.stop();
    }
  });

  it('capability-gates load, uses listed cwd with no MCP roots, and minimizes replayed history', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
    }
  }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id,
    result: { sessions: [{ sessionId: 'session-load', cwd: '/Users/example/project' }] }
  }) + '\\n');
} else if (request.method === 'session/load') {
  if (request.params.cwd !== '/Users/example/project' ||
      request.params.sessionId !== 'session-load' ||
      JSON.stringify(request.params.mcpServers) !== '[]' ||
      'additionalDirectories' in request.params) process.exit(12);
  const updates = [
    { sessionUpdate: 'user_message_chunk', messageId: 'raw-user-id', content: { type: 'text', text: 'Hello ' } },
    { sessionUpdate: 'user_message_chunk', messageId: 'raw-user-id', content: { type: 'text', text: 'Devin' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private-reasoning' } },
    { sessionUpdate: 'tool_call', toolCallId: 'tool-secret', title: 'Private tool', rawInput: { token: 'private-token' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'raw-agent-id', content: { type: 'image', data: 'private-image' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'raw-agent-id', content: { type: 'text', text: 'Ready.' }, privateExtension: 'drop-me' },
  ];
  for (const update of updates) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'session-load', update, _meta: { private: 'drop-meta' } }
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      expect(client.isSessionLoadSupported()).toBe(true);
      await expect(client.loadSession('session-load')).rejects.toThrow('listed before loading');
      await client.listSessions();
      const loaded = await client.loadSession('session-load');
      expect(loaded).toEqual({
        sessionId: 'session-load',
        cwd: '/Users/example/project',
        messages: [
          { source: 'user', text: 'Hello Devin' },
          { source: 'devin', text: 'Ready.' },
        ],
        truncated: false,
      });
      expect(JSON.stringify(loaded)).not.toMatch(
        /raw-user-id|raw-agent-id|private-reasoning|private-token|private-image|drop-me|drop-meta/,
      );
    } finally {
      await client.stop();
    }
  });

  it('keeps no-ID user turns separate across private replay boundaries', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-boundaries', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'First ' } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'turn.' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private' } },
    { sessionUpdate: 'tool_call', title: 'private tool' },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Second turn.' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
  ];
  for (const update of updates) process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 'session-boundaries', update }
  }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await client.listSessions();
      await expect(client.loadSession('session-boundaries')).resolves.toMatchObject({
        messages: [
          { source: 'user', text: 'First turn.' },
          { source: 'user', text: 'Second turn.' },
          { source: 'devin', text: 'Done.' },
        ],
      });
    } finally {
      await client.stop();
    }
  });

  it('does not invoke session/load when the capability is absent', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id,
    result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } }
  }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id,
    result: { sessions: [{ sessionId: 'session-no-load', cwd: '/tmp' }] }
  }) + '\\n');
} else if (request.method === 'session/load') {
  process.exit(13);
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await client.listSessions();
      expect(client.isSessionLoadSupported()).toBe(false);
      await expect(client.loadSession('session-no-load')).rejects.toThrow(
        'does not support session loading',
      );
    } finally {
      await client.stop();
    }
  });

  it('starts a text-only prompt asynchronously after an authorized session load', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-prompt', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  if (request.params.sessionId !== 'session-prompt' ||
      JSON.stringify(request.params.prompt) !== JSON.stringify([{ type: 'text', text: 'Continue.' }])) process.exit(18);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'session-prompt', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working.' } }
  } }) + '\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' }
  }) + '\\n'), 25);
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 1_000,
    });
    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('session-prompt');
      await expect(client.promptSession('session-prompt', 'Continue.')).resolves.toBeUndefined();
      // Wait for the post-turn ownership release + respawn (initialize +
      // authenticate round-trips) to complete.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.isSessionPromptSupported()).toBe(true);
      await expect(client.promptSession('session-prompt', 'Again.')).rejects.toThrow(
        'must be loaded before prompting',
      );
    } finally {
      await client.stop();
    }
  });

  it('exposes sanitized tool activity without exposing tool input or agent thoughts', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-activity', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'session-activity', update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'private reasoning must not leave the Mac' }
    }
  } }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'session-activity', update: {
      sessionUpdate: 'tool_call', toolCallId: 'call-1', kind: 'edit',
      title: 'Editing src/session.ts', rawInput: { token: 'private-token' }
    }
  } }) + '\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' }
  }) + '\\n'), 40);
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 1_000,
    });

    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('session-activity');
      await client.promptSession('session-activity', 'Make the change.');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const activity = await client.getSessionActivity('session-activity');
      expect(activity).toMatchObject({
        active: true,
        kind: 'editing',
        label: 'Editing src/session.ts',
      });
      expect(JSON.stringify(activity)).not.toMatch(/private-token|private reasoning|call-1/);
      let completedActivity = await client.getSessionActivity('session-activity');
      for (let attempt = 0; attempt < 20 && completedActivity?.active !== false; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completedActivity = await client.getSessionActivity('session-activity');
      }
      expect(completedActivity).toMatchObject({
        active: false,
        label: 'Response ready',
      });
    } finally {
      await client.stop();
    }
  });

  it('surfaces a validated form question and resumes only after an explicit answer', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  if (!request.params.clientCapabilities?.elicitation?.form) process.exit(31);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-question', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  globalThis.promptRequestId = request.id;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: 'agent-question-1', method: 'elicitation/create', params: {
      mode: 'form', sessionId: 'session-question', message: 'Which approach should I use?',
      requestedSchema: {
        type: 'object', required: ['approach'], properties: {
          approach: {
            type: 'string', title: 'Approach', oneOf: [
              { const: 'safe', title: 'Preserve the API' },
              { const: 'migrate', title: 'Migrate the API' }
            ]
          }
        }
      }
    }
  }) + '\\n');
} else if (request.id === 'agent-question-1') {
  if (request.result?.action !== 'accept' || request.result?.content?.approach !== 'safe') {
    process.exit(32);
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: globalThis.promptRequestId, result: { stopReason: 'end_turn' }
  }) + '\\n');
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 2_000,
    });

    try {
      await client.start();
      expect(client.isSessionElicitationSupported()).toBe(true);
      await client.listSessions();
      await client.loadSession('session-question');
      await client.promptSession('session-question', 'Implement the feature.');
      let question = client.getPendingElicitation('session-question');
      for (let attempt = 0; attempt < 20 && !question; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        question = client.getPendingElicitation('session-question');
      }
      expect(question).toMatchObject({
        message: 'Which approach should I use?',
        fields: [
          {
            key: 'approach',
            type: 'single_select',
            required: true,
            options: [
              { value: 'safe', label: 'Preserve the API' },
              { value: 'migrate', label: 'Migrate the API' },
            ],
          },
        ],
      });
      client.respondToElicitation('session-question', question?.id, {
        action: 'accept',
        content: { approach: 'safe' },
      });
      expect(client.getPendingElicitation('session-question')).toBeNull();
      let activity = await client.getSessionActivity('session-question');
      for (let attempt = 0; attempt < 20 && activity?.active; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        activity = await client.getSessionActivity('session-question');
      }
      expect(activity?.active ?? false).toBe(false);
      for (let attempt = 0; attempt < 20 && !client.isSessionListSupported(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(client.listSessions()).resolves.toMatchObject({
        sessions: [{ sessionId: 'session-question' }],
      });
    } finally {
      await client.stop();
      expect(client.isSessionElicitationSupported()).toBe(false);
    }
  });

  it('cancels a running prompt and its pending permission request', async () => {
    const logDirectory = mkdtempSync(join(tmpdir(), 'devinx-acp-cancel-'));
    temporaryDirectories.push(logDirectory);
    const logPath = join(logDirectory, 'cancel.log');
    writeFileSync(logPath, '', 'utf8');
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-permission', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  globalThis.promptRequestId = request.id;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 'session-permission',
      toolCall: { toolCallId: 'dangerous-tool' },
      options: [{ optionId: 'allow_once', kind: 'allow_once' }]
    }
  }) + '\\n');
} else if (request.id === 'permission-1') {
  if (request.result?.outcome?.outcome !== 'cancelled') process.exit(33);
  require('node:fs').appendFileSync(${JSON.stringify(logPath)}, 'permission-cancelled\\n');
} else if (request.method === 'session/cancel') {
  if (request.id !== undefined) process.exit(34);
  require('node:fs').appendFileSync(${JSON.stringify(logPath)}, 'cancel-notification\\n');
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: globalThis.promptRequestId, result: { stopReason: 'cancelled' }
  }) + '\\n');
} else if (request.method === 'session/close') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 2_000,
    });

    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('session-permission');
      await client.promptSession('session-permission', 'Use a tool.');
      let pending = client.getPendingPermission('session-permission');
      for (let attempt = 0; attempt < 20 && !pending; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pending = client.getPendingPermission('session-permission');
      }
      expect(pending).not.toBeNull();
      client.cancelSession('session-permission');
      let activity = await client.getSessionActivity('session-permission');
      for (let attempt = 0; attempt < 20 && activity?.active; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        activity = await client.getSessionActivity('session-permission');
      }
      expect(activity?.active ?? false).toBe(false);
      expect(readFileSync(logPath, 'utf8')).toBe(
        'permission-cancelled\ncancel-notification\n',
      );
      for (let attempt = 0; attempt < 20 && !client.isSessionListSupported(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(client.listSessions()).resolves.toMatchObject({
        sessions: [{ sessionId: 'session-permission' }],
      });
    } finally {
      await client.stop();
    }
  });

  it('marks failed tool activity interrupted after cancelling the active prompt', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-stop', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  globalThis.promptRequestId = request.id;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-stop',
      update: { sessionUpdate: 'tool_call', toolCallId: 'stopped-tool', title: 'Run command',
        kind: 'execute', status: 'in_progress' }
    }
  }) + '\\n');
} else if (request.method === 'session/cancel') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-stop',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'stopped-tool', status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Stopped by user' } }] }
    }
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: globalThis.promptRequestId, result: { stopReason: 'cancelled' }
  }) + '\\n');
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 1_000,
      promptTimeoutMs: 2_000,
    });

    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('session-stop');
      await client.promptSession('session-stop', 'Use a tool.');
      let turn = client.getSessionTurn('session-stop');
      for (
        let attempt = 0;
        attempt < 20 && !turn?.activity.some((entry) => entry.status === 'running');
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        turn = client.getSessionTurn('session-stop');
      }
      expect(turn?.activity).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: 'running' })]),
      );

      client.cancelSession('session-stop');
      for (
        let attempt = 0;
        attempt < 20 && !turn?.activity.some((entry) => entry.status === 'interrupted');
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        turn = client.getSessionTurn('session-stop');
      }
      expect(turn?.activity).toEqual(
        expect.arrayContaining([expect.objectContaining({ status: 'interrupted' })]),
      );
    } finally {
      await client.stop();
    }
  });

  it('applies an exact loaded-session model before prompting and rejects stale IDs', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-model', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'swe-1.7-medium',
      options: [
        { value: 'swe-1.7-medium', name: 'SWE-1.7 Medium' },
        { value: 'swe-1.7-high', name: 'SWE-1.7 High' }
      ]
    }]
  } }) + '\\n');
} else if (request.method === 'session/set_config_option') {
  if (request.params.sessionId !== 'session-model' ||
      request.params.configId !== 'model' ||
      request.params.value !== 'swe-1.7-high') process.exit(31);
  globalThis.modelConfigured = true;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'swe-1.7-high',
      options: [
        { value: 'swe-1.7-medium', name: 'SWE-1.7 Medium' },
        { value: 'swe-1.7-high', name: 'SWE-1.7 High' }
      ]
    }]
  } }) + '\\n');
} else if (request.method === 'session/prompt') {
  if (!globalThis.modelConfigured || request.params.sessionId !== 'session-model') process.exit(32);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    stopReason: 'end_turn'
  } }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await client.listSessions();
      const loaded = await client.loadSession('session-model');
      expect(loaded.modelId).toBe('swe-1.7-medium');
      await expect(
        client.promptSession('session-model', 'Continue.', 'stale-model'),
      ).rejects.toThrow('model is not available');
      await expect(
        client.promptSession('session-model', 'Continue.', 'swe-1.7-high'),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.stop();
    }
  });

  it('uses session close after a prompt when the agent advertises it', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  globalThis.listCount = (globalThis.listCount || 0) + 1;
  if (globalThis.listCount > 1 && !globalThis.closed) process.exit(28);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-close', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    stopReason: 'end_turn'
  } }) + '\\n');
} else if (request.method === 'session/close') {
  if (request.params.sessionId !== 'session-close') process.exit(27);
  globalThis.closed = true;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });
    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('session-close');
      await client.promptSession('session-close', 'Continue.');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(client.isSessionPromptSupported()).toBe(true);
      await expect(client.listSessions()).resolves.toEqual({
        sessions: [{ sessionId: 'session-close', cwd: '/tmp/project' }],
        nextCursor: undefined,
      });
    } finally {
      await client.stop();
    }
  });

  it('creates a new session with bounded embedded history before prompting it', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { embeddedContext: true } }
  } }) + '\\n');
} else if (request.method === 'session/new') {
  if (request.params.cwd !== '/tmp/project' ||
      JSON.stringify(request.params.mcpServers) !== '[]') process.exit(19);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessionId: 'session-continuation'
  } }) + '\\n');
} else if (request.method === 'session/prompt') {
  const prompt = request.params.prompt;
  if (request.params.sessionId !== 'session-continuation' ||
      prompt.length !== 2 ||
      prompt[0].type !== 'resource' ||
      prompt[0].resource.uri !== 'devinx://continuation/history.md' ||
      prompt[0].resource.mimeType !== 'text/markdown' ||
      prompt[0].resource.text !== '# Prior history' ||
      JSON.stringify(prompt[1]) !== JSON.stringify({ type: 'text', text: 'Continue.' })) process.exit(20);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    stopReason: 'end_turn'
  } }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await expect(
        client.createContinuation('/tmp/project', '# Prior history', 'Continue.'),
      ).resolves.toBe('session-continuation');
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.stop();
    }
  });

  it('creates a local session, applies an offered model, then starts the prompt', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: {}
  } }) + '\\n');
} else if (request.method === 'session/new') {
  if (request.params.cwd !== '/tmp/project' ||
      JSON.stringify(request.params.mcpServers) !== '[]') process.exit(21);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessionId: 'session-created',
    configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'adaptive',
      options: [
        { value: 'adaptive', name: 'Adaptive' },
        { value: 'gpt-5-6-sol-medium', name: 'GPT 5.6' }
      ]
    }]
  } }) + '\\n');
} else if (request.method === 'session/set_config_option') {
  if (request.params.sessionId !== 'session-created' ||
      request.params.configId !== 'model' ||
      request.params.value !== 'adaptive') process.exit(22);
  globalThis.modelConfigured = true;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'adaptive',
      options: [
        { value: 'adaptive', name: 'Adaptive' },
        { value: 'gpt-5-6-sol-medium', name: 'GPT 5.6' }
      ]
    }]
  } }) + '\\n');
} else if (request.method === 'session/prompt') {
  if (!globalThis.modelConfigured ||
      request.params.sessionId !== 'session-created' ||
      JSON.stringify(request.params.prompt) !== JSON.stringify([
        { type: 'text', text: 'Build it.' }
      ])) process.exit(23);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    stopReason: 'end_turn'
  } }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await expect(client.createSession('/tmp/project', 'adaptive', 'Build it.')).resolves.toBe(
        'session-created',
      );
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.stop();
    }
  });

  it('serves an active snapshot for a newly created session while load remains busy', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
  } }) + '\\n');
} else if (request.method === 'session/new') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessionId: 'session-active-new'
  } }) + '\\n');
} else if (request.method === 'session/prompt') {
  globalThis.promptId = request.id;
} else if (request.method === 'session/cancel') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: globalThis.promptId, result: { stopReason: 'cancelled' }
  }) + '\\n');
} else if (request.method === 'session/close') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      const sessionId = await client.createSession('/tmp/project', null, 'Count to 30');
      await expect(client.loadSession(sessionId)).rejects.toBeInstanceOf(AcpBusyError);
      expect(client.getActiveTurnSnapshot(sessionId)).toMatchObject({
        sessionId,
        cwd: '/tmp/project',
        messages: [{ source: 'user', text: 'Count to 30' }],
      });
      expect(client.getActiveTurnSnapshot('another-session')).toBeNull();
      client.cancelSession(sessionId);
      for (let attempt = 0; attempt < 20 && client.getActiveTurnSnapshot(sessionId); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(client.getActiveTurnSnapshot(sessionId)).toBeNull();
    } finally {
      await client.stop();
    }
  });

  it('includes loaded replay messages in an active prompt snapshot', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-active-loaded', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  for (const [sessionUpdate, text] of [
    ['user_message_chunk', 'Earlier question'],
    ['agent_message_chunk', 'Earlier answer']
  ]) process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'session-active-loaded',
      update: { sessionUpdate, content: { type: 'text', text } }
    }
  }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  globalThis.promptId = request.id;
} else if (request.method === 'session/cancel') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: globalThis.promptId, result: { stopReason: 'cancelled' }
  }) + '\\n');
} else if (request.method === 'session/close') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('session-active-loaded');
      await client.promptSession('session-active-loaded', 'next');
      expect(client.getActiveTurnSnapshot('session-active-loaded')?.messages).toEqual([
        { source: 'user', text: 'Earlier question' },
        { source: 'devin', text: 'Earlier answer' },
        { source: 'user', text: 'next' },
      ]);
      client.cancelSession('session-active-loaded');
    } finally {
      await client.stop();
    }
  });

  it('sanitizes authoritative model metadata and ignores untrusted badge fields', () => {
    expect(
      parseAcpModelCatalog([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'adaptive',
          options: [
            {
              value: 'adaptive',
              name: 'Adaptive',
              description: 'Balances quality and cost',
              _meta: {
                'cognition.ai/supportsImages': true,
                'cognition.ai/badge': 'new',
                privateToken: 'do-not-return',
              },
            },
            {
              value: 'deepseek-v4',
              name: 'DeepSeek V4 Pro',
              _meta: { 'cognition.ai/badge': 'guessed-promo' },
            },
          ],
        },
      ]),
    ).toEqual({
      defaultModelId: 'adaptive',
      models: [
        {
          id: 'adaptive',
          name: 'Adaptive',
          description: 'Balances quality and cost',
          supportsImages: true,
          badge: 'new',
        },
        { id: 'deepseek-v4', name: 'DeepSeek V4 Pro' },
      ],
    });
  });

  it('discovers and caches the full model catalog from a bounded existing-session load', async () => {
    const executablePath = fakeCli(`
globalThis.catalogLoads = globalThis.catalogLoads || 0;
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [
      { sessionId: 'session-locked', cwd: '/tmp/locked' },
      { sessionId: 'session-catalog', cwd: '/tmp/catalog' }
    ]
  } }) + '\\n');
} else if (request.method === 'session/load' && request.params.sessionId === 'session-locked') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
    code: -32600, message: 'Session is already open in another process'
  } }) + '\\n');
} else if (request.method === 'session/load') {
  globalThis.catalogLoads += 1;
  const modelOptions = globalThis.catalogLoads > 1
    ? [
        { value: 'adaptive', name: 'Adaptive' },
        { value: 'deepseek-v4', name: 'DeepSeek V4 Pro' },
        { value: 'swe-1.8', name: 'SWE-1.8' }
      ]
    : [
        { value: 'adaptive', name: 'Adaptive' },
        { value: 'deepseek-v4', name: 'DeepSeek V4 Pro' }
      ];
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'adaptive',
      options: modelOptions
    }]
  } }) + '\\n');
} else if (request.method === 'session/close') {
  if (request.params.sessionId !== 'session-catalog') process.exit(29);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
} else if (request.method === 'session/new' || request.method === 'session/prompt') {
  process.exit(25);
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });
    try {
      await client.start();
      const first = await client.listModelCatalog();
      const second = await client.listModelCatalog();
      const refreshed = await client.listModelCatalog(true);
      expect(first).toEqual({
        defaultModelId: 'adaptive',
        models: [
          { id: 'adaptive', name: 'Adaptive' },
          { id: 'deepseek-v4', name: 'DeepSeek V4 Pro' },
        ],
      });
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(refreshed).toEqual({
        defaultModelId: 'adaptive',
        models: [
          { id: 'adaptive', name: 'Adaptive' },
          { id: 'deepseek-v4', name: 'DeepSeek V4 Pro' },
          { id: 'swe-1.8', name: 'SWE-1.8' },
        ],
      });
    } finally {
      await client.stop();
    }
  });

  it('rejects duplicate or unavailable defaults in ACP model catalogs', () => {
    const base = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'missing',
      options: [{ value: 'adaptive', name: 'Adaptive' }],
    };
    expect(() => parseAcpModelCatalog([base])).toThrow('default is unavailable');
    expect(() =>
      parseAcpModelCatalog([
        {
          ...base,
          currentValue: 'adaptive',
          options: [
            { value: 'adaptive', name: 'Adaptive' },
            { value: 'adaptive', name: 'Duplicate' },
          ],
        },
      ]),
    ).toThrow('duplicate IDs');
  });

  it('fails closed before prompting when a requested model is not offered', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: {}
  } }) + '\\n');
} else if (request.method === 'session/new') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessionId: 'session-created',
    configOptions: [{
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'adaptive', options: [{ value: 'adaptive', name: 'Adaptive' }]
    }]
  } }) + '\\n');
} else if (request.method === 'session/prompt' ||
           request.method === 'session/set_config_option') {
  process.exit(24);
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await expect(
        client.createSession('/tmp/project', 'gpt-5-6-sol-medium', 'Do not send.'),
      ).rejects.toThrow('model is not available');
    } finally {
      await client.stop();
    }
  });

  it.each([-32600, -32015])(
    'classifies session ownership error %i without exposing text',
    async (code) => {
      const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-locked', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
    code: ${code}, message: "Session 'private-id' is already open in another process"
  } }) + '\\n');
}`);
      const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

      try {
        await client.start();
        await client.listSessions();
        const error = await client
          .loadSession('session-locked')
          .catch((failure: unknown) => failure);
        expect(isAcpSessionInUseError(error)).toBe(true);
        expect(String(error)).not.toContain('private-id');
      } finally {
        await client.stop();
      }
    },
  );

  it('bounds replayed text history to the newest 200 messages', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } }
  }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id,
    result: { sessions: [{ sessionId: 'session-many', cwd: '/tmp/project' }] }
  }) + '\\n');
} else if (request.method === 'session/load') {
  for (let index = 0; index < 201; index += 1) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'session-many',
        update: {
          sessionUpdate: index % 2 === 0 ? 'user_message_chunk' : 'agent_message_chunk',
          messageId: 'message-' + index,
          content: { type: 'text', text: 'message-' + index }
        }
      }
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 2_000 });

    try {
      await client.start();
      await client.listSessions();
      const loaded = await client.loadSession('session-many');
      expect(loaded.messages).toHaveLength(200);
      expect(loaded.messages[0]?.text).toBe('message-1');
      expect(loaded.messages.at(-1)?.text).toBe('message-200');
      expect(loaded.truncated).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it('drops differently-associated replay records without exposing or aborting history', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } }
  }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id,
    result: { sessions: [{ sessionId: 'session-right', cwd: '/tmp/project' }] }
  }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: 'session-wrong',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong' } }
    }
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: {
      sessionId: 'session-right',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'safe' } }
    }
  }) + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    await client.start();
    await client.listSessions();
    await expect(client.loadSession('session-right')).resolves.toMatchObject({
      messages: [{ source: 'devin', text: 'safe' }],
      truncated: true,
    });
    expect(client.isSessionLoadSupported()).toBe(true);
    await client.stop();
  });

  it('decodes UTF-8 JSON safely when a character spans stdout chunks', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { list: {} } }
    }
  }) + '\\n');
} else if (request.method === 'session/list') {
  const payload = Buffer.from(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: { sessions: [{ sessionId: 'session-utf8', cwd: '/tmp', title: 'Devin 🦦' }] }
  }) + '\\n', 'utf8');
  const marker = payload.indexOf(Buffer.from('🦦'));
  process.stdout.write(payload.subarray(0, marker + 1));
  setTimeout(() => process.stdout.write(payload.subarray(marker + 1)), 10);
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    try {
      await client.start();
      await expect(client.listSessions()).resolves.toMatchObject({
        sessions: [{ title: 'Devin 🦦' }],
      });
    } finally {
      await client.stop();
    }
  });

  it.each([
    ['relative workspace paths', [{ sessionId: 'session-relative', cwd: 'relative/path' }]],
    ['invalid metadata shapes', [{ sessionId: 'session-meta', cwd: '/tmp', _meta: 'invalid' }]],
    [
      'duplicate session IDs',
      [
        { sessionId: 'session-duplicate', cwd: '/tmp/one' },
        { sessionId: 'session-duplicate', cwd: '/tmp/two' },
      ],
    ],
  ])('fails closed on %s', async (_label, sessions) => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { list: {} } }
    }
  }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      sessions: ${JSON.stringify(sessions)}
    }
  }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    await client.start();
    await expect(client.listSessions()).rejects.toThrow('response failed validation');
    await expect(client.listSessions()).rejects.toThrow('not started');
    await client.stop();
  });

  it('terminates when initialization times out', async () => {
    const executablePath = fakeCli(`void request;`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 75 });

    await expect(client.start()).rejects.toThrow('initialization timed out');
    await client.stop();
  });

  it('rejects an oversized JSON-RPC line before parsing it', async () => {
    const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write('x'.repeat(1024 * 1024 + 1));
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });

    await expect(client.start()).rejects.toThrow('size limit');
    await client.stop();
  });

  it('applies per-turn ACP modes before prompting and rejects unavailable bypass mode', async () => {
    async function runModeTurn(
      currentModeId: string,
      modeIds: string[],
      autoApprove: boolean | undefined,
      reportedModes?: unknown,
    ): Promise<{ error: unknown; events: string[] }> {
      const directory = mkdtempSync(join(tmpdir(), 'devinx-acp-mode-'));
      temporaryDirectories.push(directory);
      const logPath = join(directory, 'events.log');
      writeFileSync(logPath, '', 'utf8');
      const availableModes = modeIds.map((id) => ({ id, name: id }));
      const executablePath = fakeCli(`
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 'session-mode', cwd: '/tmp/project' }]
  } }) + '\\n');
} else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    modes: ${JSON.stringify(reportedModes ?? { currentModeId, availableModes })}
  } }) + '\\n');
} else if (request.method === 'session/set_mode') {
  require('node:fs').appendFileSync(${JSON.stringify(logPath)}, 'mode:' + request.params.modeId + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
} else if (request.method === 'session/prompt') {
  require('node:fs').appendFileSync(${JSON.stringify(logPath)}, 'prompt\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }) + '\\n');
} else if (request.method === 'session/close') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
}`);
      const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 1_000 });
      try {
        await client.start();
        await client.listSessions();
        await client.loadSession('session-mode');
        let error: unknown;
        try {
          await client.promptSession('session-mode', 'Continue.', undefined, autoApprove);
        } catch (caught) {
          error = caught;
        }
        if (error === undefined) {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            if (readFileSync(logPath, 'utf8').includes('prompt')) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        return {
          error,
          events: readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean),
        };
      } finally {
        await client.stop();
      }
    }

    const unavailable = await runModeTurn('accept-edits', ['accept-edits', 'ask', 'plan'], true);
    expect(unavailable.error).toBeInstanceOf(AcpAutoApproveUnavailableError);
    expect(unavailable.events).not.toContain('prompt');
    const malformedModes = { currentModeId: 5 };
    const withoutAutoApprove = await runModeTurn(
      'accept-edits',
      [],
      undefined,
      malformedModes,
    );
    expect(withoutAutoApprove.error).toBeUndefined();
    expect(withoutAutoApprove.events).toEqual(['prompt']);
    const withAutoApprove = await runModeTurn('accept-edits', [], true, malformedModes);
    expect(withAutoApprove.error).toBeInstanceOf(AcpAutoApproveUnavailableError);
    expect(withAutoApprove.events).not.toContain('prompt');
    await expect(
      runModeTurn('accept-edits', ['accept-edits', 'ask', 'plan', 'bypass'], true),
    ).resolves.toMatchObject({ events: ['mode:bypass', 'prompt'] });
    await expect(
      runModeTurn('bypass', ['accept-edits', 'ask', 'plan', 'bypass'], false),
    ).resolves.toMatchObject({ events: ['mode:accept-edits', 'prompt'] });
    await expect(
      runModeTurn('accept-edits', ['accept-edits', 'ask', 'plan', 'bypass'], undefined),
    ).resolves.toMatchObject({ events: ['prompt'] });
  });
});
