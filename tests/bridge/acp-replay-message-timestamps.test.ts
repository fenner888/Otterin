import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpSessionClient } from '../../bridge/src/acp';

describe('ACP replay message timestamps', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function fakeCli(body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'devinx-acp-message-times-'));
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

  it('keeps timestamps aligned and uses only the first chunk timestamp in each message', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  const updates = [
    { sessionUpdate: 'user_message_chunk', messageId: 'user-1',
      content: { type: 'text', text: 'Hello ' },
      _meta: { 'cognition.ai/timestamp': '2026-09-28T15:41:00.123Z' } },
    { sessionUpdate: 'user_message_chunk', messageId: 'user-1',
      content: { type: 'text', text: 'there.' },
      _meta: { 'cognition.ai/timestamp': '2026-09-28T15:41:03.456Z' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'agent-1',
      content: { type: 'text', text: 'Done.' },
      _meta: { 'cognition.ai/timestamp': 1790610060123 } },
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
        { source: 'user', text: 'Hello there.' },
        { source: 'devin', text: 'Done.' },
      ]);
      expect(loaded.messageTimes).toEqual([
        Date.parse('2026-09-28T15:41:00.123Z'),
        1_790_610_060_123,
      ]);
      expect(Object.prototype.propertyIsEnumerable.call(loaded, 'messageTimes')).toBe(false);
      expect(Object.keys(loaded.messages[0] ?? {})).toEqual(['source', 'text']);
    } finally {
      await client.stop();
    }
  });

  it('shifts timestamps with messages when replay history is capped', async () => {
    const executablePath = fakeCli(`${READY}
else if (request.method === 'session/load') {
  const updates = Array.from({ length: 201 }, (_, index) => ({
    sessionUpdate: 'user_message_chunk',
    messageId: 'message-' + index,
    content: { type: 'text', text: 'message-' + index },
    _meta: { 'cognition.ai/timestamp': 1_000 + index },
  }));
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

      expect(loaded.messages).toHaveLength(200);
      expect(loaded.messages[0]?.text).toBe('message-1');
      expect(loaded.messageTimes).toHaveLength(200);
      expect(loaded.messageTimes?.[0]).toBe(1_001);
      expect(loaded.messageTimes?.[199]).toBe(1_200);
      expect(loaded.truncated).toBe(true);
    } finally {
      await client.stop();
    }
  });
});
