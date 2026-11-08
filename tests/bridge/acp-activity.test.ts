import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpSessionClient, safeAcpChildEnvironment } from '../../bridge/src/acp';

describe('ACP activity timeline', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    delete process.env.DEVINX_TEST_SECRET;
    delete process.env.WINDSURF_API_KEY;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function fakeCli(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'devinx-acp-activity-'));
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
    return executable;
  }

  const READY = `
if (request.method === 'initialize') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } }
  } }) + '\\n');
} else if (request.method === 'session/list') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    sessions: [{ sessionId: 's1', cwd: '/Users/tester/ws' }]
  } }) + '\\n');
}`;

  it('forwards WINDSURF_API_KEY but not unrelated secrets to the CLI child', () => {
    const environment = safeAcpChildEnvironment({
      NODE_ENV: 'test',
      WINDSURF_API_KEY: 'cli-auth-token',
      AWS_SECRET_ACCESS_KEY: 'must-not-forward',
      HOME: '/Users/tester',
    });
    expect(environment.WINDSURF_API_KEY).toBe('cli-auth-token');
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('replays thought and tool updates into the activity timeline with replay timestamps', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Change hello to goodbye.' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'First read the file.' },
      _meta: { 'cognition.ai/timestamp': '2026-09-27T21:28:38.000Z' } },
    { sessionUpdate: 'tool_call', toolCallId: 'call_read', title: 'Read file', kind: 'read',
      locations: [{ path: '/Users/tester/ws/notes.txt' }],
      _meta: { 'cognition.ai/inferenceToolName': 'read',
               'cognition.ai/timestamp': '2026-09-27T21:28:38.438828+00:00' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_read', status: 'completed',
      _meta: { 'cognition.ai/timestamp': '2026-09-27T21:28:38.538974+00:00' } },
    { sessionUpdate: 'tool_call', toolCallId: 'call_edit', title: 'Edit file', kind: 'edit',
      content: [{ type: 'diff', path: '/Users/tester/ws/notes.txt',
                  oldText: 'hello world\\n', newText: 'goodbye world\\n' }],
      locations: [{ path: '/Users/tester/ws/notes.txt' }],
      _meta: { 'cognition.ai/inferenceToolName': 'edit',
               'cognition.ai/timestamp': '2026-09-27T21:28:42.402370+00:00' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_edit', status: 'completed',
      _meta: { 'cognition.ai/timestamp': '2026-09-27T21:28:42.459532+00:00' } },
    { sessionUpdate: 'tool_call', toolCallId: 'call_fetch', title: 'Fetched https://example.com',
      kind: 'fetch', rawInput: { url: 'https://example.com' },
      _meta: { 'cognition.ai/inferenceToolName': 'webfetch',
               'cognition.ai/timestamp': '2026-09-27T21:28:42.402370+00:00' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_fetch', status: 'completed',
      _meta: { 'cognition.ai/timestamp': '2026-09-27T21:28:42.459536+00:00' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
  ];
  for (const update of updates) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 's1', update }
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 2_000 });
    try {
      await client.start();
      await client.listSessions();
      const loaded = await client.loadSession('s1');
      expect(loaded.messages).toEqual([
        { source: 'user', text: 'Change hello to goodbye.' },
        { source: 'devin', text: 'Done.' },
      ]);
      const activity = loaded.activity ?? [];
      const kinds = activity.map((entry) => entry.kind);
      expect(kinds).toEqual(['thought', 'tool', 'tool', 'tool']);
      expect(activity.map((entry) => entry.afterSequence)).toEqual([1, 1, 1, 1]);
      const [thought, read, edit, fetchEntry] = activity;
      expect(thought?.status).toBe('completed');
      expect(read).toMatchObject({
        toolKind: 'read',
        status: 'completed',
        title: 'Read file',
        paths: ['notes.txt'],
        startedAt: Date.parse('2026-09-27T21:28:38.438828+00:00'),
        endedAt: Date.parse('2026-09-27T21:28:38.538974+00:00'),
      });
      expect(edit).toMatchObject({ toolKind: 'edit', status: 'completed' });
      expect(edit?.detail).toEqual({
        type: 'diff',
        path: 'notes.txt',
        oldText: 'hello world\n',
        newText: 'goodbye world\n',
      });
      expect(fetchEntry).toMatchObject({ toolKind: 'fetch', status: 'completed' });
      expect(JSON.stringify(activity)).not.toContain('/Users/tester');
    } finally {
      await client.stop();
    }
  });

  async function turnEventually(
    client: AcpSessionClient,
    sessionId: string,
    ready: (turn: NonNullable<ReturnType<AcpSessionClient['getSessionTurn']>>) => boolean,
  ) {
    let turn = client.getSessionTurn(sessionId);
    for (let attempt = 0; attempt < 40 && !(turn && ready(turn)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      turn = client.getSessionTurn(sessionId);
    }
    return turn;
  }

  it('collects a live turn for getSessionTurn and keeps it readable after the prompt', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me edit.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'call_live', title: 'Ran test', kind: 'execute',
      content: [{ type: 'content', content: { type: 'resource',
        resource: { mimeType: 'text/x-shellscript', text: 'npm test', uri: 'tool://preview' } } }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_live', status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'passing' } }],
      _meta: { 'terminal_exit': { exit_code: 0, signal: null } } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'call_live', status: 'completed' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'green.' } },
  ];
  for (const update of updates) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 's1', update }
    }) + '\\n');
  }
  setTimeout(() => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' }
  }) + '\\n'), 30);
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });
    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('s1');
      await client.promptSession('s1', 'Run the tests.');
      const turn = await turnEventually(client, 's1', (value) => value.reply === 'All green.');
      expect(turn).not.toBeNull();
      expect(turn?.startedAt).toBeGreaterThan(0);
      expect(turn?.reply).toBe('All green.');
      const entries = turn?.activity ?? [];
      expect(entries.map((entry) => entry.kind)).toEqual(['thought', 'tool']);
      expect(entries[1]).toMatchObject({ toolKind: 'execute', status: 'completed' });
      const text = (entries[1]?.detail as { text: string }).text;
      expect(text).toContain('$ npm test');
      expect(text).toContain('passing');
      expect(text).toContain('Exit code: 0');
    } finally {
      await client.stop();
    }
  });

  it('marks a still-running tool interrupted when the turn ends', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's1', update: {
      sessionUpdate: 'tool_call', toolCallId: 'call_stuck', title: 'Ran watch', kind: 'execute' } }
  }) + '\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' }
  }) + '\\n'), 30);
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });
    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('s1');
      await client.promptSession('s1', 'Watch.');
      const turn = await turnEventually(
        client,
        's1',
        (value) => value.activity[0]?.status === 'interrupted',
      );
      expect(turn?.activity[0]?.status).toBe('interrupted');
      // Readable after finishPrompt, cleared by the next stop().
      await client.stop();
      expect(client.getSessionTurn('s1')).toBeNull();
    } finally {
      await client.stop();
    }
  });

  it('closes an open thought when a replay message chunk follows it', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Go.' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking hard.' },
      _meta: { 'cognition.ai/timestamp': '2026-09-27T21:28:38.000Z' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' },
      _meta: { 'cognition.ai/timestamp': '2026-09-27T21:28:40.000Z' } },
  ];
  for (const update of updates) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 's1', update }
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 2_000 });
    try {
      await client.start();
      await client.listSessions();
      const loaded = await client.loadSession('s1');
      const thought = (loaded.activity ?? []).find((entry) => entry.kind === 'thought');
      expect(thought?.status).toBe('completed');
      expect(thought?.endedAt).toBe(Date.parse('2026-09-27T21:28:40.000Z'));
    } finally {
      await client.stop();
    }
  });

  it('marks a tool still in progress at the end of replay as interrupted', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  const updates = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Watch.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'call_stuck', title: 'Ran watch', kind: 'execute',
      _meta: { 'cognition.ai/timestamp': '2026-09-27T21:28:39.000Z' } },
  ];
  for (const update of updates) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 's1', update }
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
}`);
    const client = new AcpSessionClient({ executablePath, requestTimeoutMs: 2_000 });
    try {
      await client.start();
      await client.listSessions();
      const loaded = await client.loadSession('s1');
      const tool = (loaded.activity ?? []).find((entry) => entry.kind === 'tool');
      expect(tool?.status).toBe('interrupted');
      expect(tool?.endedAt).toBe(Date.parse('2026-09-27T21:28:39.000Z'));
    } finally {
      await client.stop();
    }
  });

  it('closes an open thought when a live message chunk follows it', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Almost done.' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished.' } },
  ];
  for (const update of updates) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 's1', update }
    }) + '\\n');
  }
  setTimeout(() => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' }
  }) + '\\n'), 30);
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });
    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('s1');
      await client.promptSession('s1', 'Wrap up.');
      const turn = await turnEventually(client, 's1', (value) => value.reply === 'Finished.');
      const thought = turn?.activity.find((entry) => entry.kind === 'thought');
      expect(thought?.status).toBe('completed');
    } finally {
      await client.stop();
    }
  });

  it('clips the live reply to the 100 KiB message contract', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: null }) + '\\n');
} else if (request.method === 'session/prompt') {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's1', update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'y'.repeat(102 * 1024) } } }
  }) + '\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' }
  }) + '\\n'), 30);
}`);
    const client = new AcpSessionClient({
      executablePath,
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });
    try {
      await client.start();
      await client.listSessions();
      await client.loadSession('s1');
      await client.promptSession('s1', 'Write a lot.');
      const turn = await turnEventually(client, 's1', (value) => value.replyTruncated);
      expect(turn).not.toBeNull();
      expect(Buffer.byteLength(turn?.reply ?? '', 'utf8')).toBeLessThanOrEqual(100_000);
      expect(turn?.replyTruncated).toBe(true);
    } finally {
      await client.stop();
    }
  });
});
