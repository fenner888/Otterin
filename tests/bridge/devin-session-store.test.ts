import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DevinSessionStore } from '../../bridge/src/devin-session-store';

function createFixture(path: string, schemaVersion = 16): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      main_chain_id INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT 'adaptive',
      agent_mode TEXT NOT NULL DEFAULT 'agent',
      last_activity_at TEXT NOT NULL DEFAULT '2026-07-11T00:00:00.000Z',
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      UNIQUE(session_id, node_id)
    );
  `);
  database.prepare('INSERT INTO refinery_schema_history(version) VALUES (?)').run(schemaVersion);
  return database;
}

function createSchema19Fixture(path: string): DatabaseSync {
  const database = createFixture(path, 19);
  database.exec(`
    CREATE TABLE tool_call_state (
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_call_json TEXT,
      tool_call_update_json TEXT,
      source_node_ids TEXT,
      PRIMARY KEY(session_id, tool_call_id)
    );
    CREATE VIRTUAL TABLE message_search USING fts5(content);
    CREATE TRIGGER message_nodes_search_insert
    AFTER INSERT ON message_nodes
    BEGIN
      INSERT INTO message_search(rowid, content)
      VALUES (new.row_id, json_extract(new.chat_message, '$.content'));
    END;
  `);
  return database;
}

function insertNode(
  database: DatabaseSync,
  input: {
    sessionId: string;
    nodeId: number;
    parentNodeId?: number;
    role: string;
    content: string;
    privateValue?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO message_nodes(
        session_id, node_id, parent_node_id, chat_message
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.nodeId,
      input.parentNodeId ?? null,
      JSON.stringify({
        role: input.role,
        content: input.content,
        thinking: input.privateValue,
        tool_calls: input.privateValue ? [{ private: input.privateValue }] : undefined,
      }),
    );
}

describe('read-only Devin session store', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'devinx-session-store-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each([16, 17, 18, 19, 20])(
    'reads only main-chain text during a WAL writer on schema %i',
    async (version) => {
      const databasePath = join(directory, 'sessions.db');
      const writer = createFixture(databasePath, version);
      const sessionId = 'session-main-chain';
      writer
        .prepare('INSERT INTO sessions(id, working_directory, main_chain_id) VALUES (?, ?, ?)')
        .run(sessionId, '/Users/example/project', 5);
      insertNode(writer, {
        sessionId,
        nodeId: 1,
        role: 'system',
        content: 'private-system-prompt',
      });
      insertNode(writer, {
        sessionId,
        nodeId: 2,
        parentNodeId: 1,
        role: 'user',
        content: 'Build this.',
        privateValue: 'private-user-metadata',
      });
      insertNode(writer, {
        sessionId,
        nodeId: 3,
        parentNodeId: 2,
        role: 'assistant',
        content: 'Working.',
        privateValue: 'private-reasoning',
      });
      insertNode(writer, {
        sessionId,
        nodeId: 4,
        parentNodeId: 3,
        role: 'tool',
        content: 'private-tool-output',
      });
      insertNode(writer, {
        sessionId,
        nodeId: 5,
        parentNodeId: 4,
        role: 'assistant',
        content: 'Done.',
      });
      insertNode(writer, {
        sessionId,
        nodeId: 6,
        parentNodeId: 2,
        role: 'assistant',
        content: 'private-abandoned-branch',
      });
      if (version === 17) {
        writer.exec(`CREATE TABLE subagent_heads (
        session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        chain_node_id INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, agent_id)
      )`);
        writer
          .prepare('INSERT INTO subagent_heads VALUES (?, ?, ?, ?)')
          .run(sessionId, 'private-subagent', 6, 1);
      }
      await chmod(databasePath, 0o600);

      try {
        const store = new DevinSessionStore({ databasePath });
        await store.start();
        const loaded = await store.loadSession(sessionId);
        expect(loaded).toEqual({
          sessionId,
          cwd: '/Users/example/project',
          modelId: 'adaptive',
          messages: [
            { source: 'user', text: 'Build this.' },
            { source: 'devin', text: 'Working.' },
            { source: 'devin', text: 'Done.' },
          ],
          truncated: false,
        });
        expect(JSON.stringify(loaded)).not.toMatch(
          /private-system-prompt|private-user-metadata|private-reasoning|private-tool-output|private-abandoned-branch/,
        );
      } finally {
        writer.close();
      }
    },
  );

  it('clips large history messages to the phone response contract', async () => {
    const databasePath = join(directory, 'sessions.db');
    const writer = createFixture(databasePath, 17);
    writer
      .prepare('INSERT INTO sessions(id, working_directory, main_chain_id) VALUES (?, ?, ?)')
      .run('large-message', '/tmp/project', 1);
    insertNode(writer, {
      sessionId: 'large-message',
      nodeId: 1,
      role: 'assistant',
      content: 'a'.repeat(102_400),
    });
    writer.close();
    await chmod(databasePath, 0o600);
    const store = new DevinSessionStore({ databasePath });
    await store.start();
    const loaded = await store.loadSession('large-message');
    expect(loaded.messages[0]?.text).toHaveLength(100_000);
    expect(loaded.truncated).toBe(true);
    await store.stop();
  });

  it('fails closed for an unreviewed schema version', async () => {
    const databasePath = join(directory, 'sessions.db');
    const database = createFixture(databasePath, 21);
    database.close();
    await chmod(databasePath, 0o600);

    await expect(new DevinSessionStore({ databasePath }).start()).rejects.toThrow(
      'schema is not supported',
    );
  });

  it.each([16, 17, 18, 19, 20])(
    'lists only visible, recently observed local workspaces and models on schema %i',
    async (version) => {
      const databasePath = join(directory, 'sessions.db');
      const database = createFixture(databasePath, version);
      database
        .prepare(
          `INSERT INTO sessions(
          id, working_directory, main_chain_id, model, agent_mode, last_activity_at, hidden
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'session-visible',
          '/Users/example/current-project',
          0,
          'gpt-5-6-sol-medium',
          'agent',
          '2026-07-11T12:00:00.000Z',
          0,
        );
      database
        .prepare(
          `INSERT INTO sessions(
          id, working_directory, main_chain_id, model, agent_mode, last_activity_at, hidden
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'session-hidden',
          '/Users/example/private-project',
          0,
          'private-model',
          'agent',
          '2026-07-11T13:00:00.000Z',
          1,
        );
      database.close();
      await chmod(databasePath, 0o600);

      const store = new DevinSessionStore({ databasePath });
      await store.start();
      await expect(store.listCreateOptions()).resolves.toEqual({
        workspaces: [{ path: '/Users/example/current-project' }],
        models: [{ id: 'gpt-5-6-sol-medium' }],
      });
      await expect(store.getSessionPresentation('session-visible')).resolves.toEqual({
        modelId: 'gpt-5-6-sol-medium',
        agentMode: 'agent',
      });
      await expect(store.getSessionPresentation('session-hidden')).rejects.toThrow(
        'metadata is unavailable',
      );
      await store.stop();
    },
  );

  it('reads realistic schema 19 without changing the database file', async () => {
    const databasePath = join(directory, 'sessions.db');
    const database = createSchema19Fixture(databasePath);
    database
      .prepare(
        `INSERT INTO sessions(
          id, working_directory, main_chain_id, model, agent_mode, last_activity_at, hidden
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-schema-19',
        '/Users/example/schema-19-project',
        2,
        'gpt-5-6-sol-medium',
        'agent',
        '2026-07-11T12:00:00.000Z',
        0,
      );
    insertNode(database, {
      sessionId: 'session-schema-19',
      nodeId: 1,
      role: 'user',
      content: 'Read schema 19.',
    });
    insertNode(database, {
      sessionId: 'session-schema-19',
      nodeId: 2,
      parentNodeId: 1,
      role: 'assistant',
      content: 'Schema 19 is supported.',
    });
    database.close();
    await chmod(databasePath, 0o600);
    const before = await readFile(databasePath);

    const store = new DevinSessionStore({ databasePath });
    await store.start();
    expect(store.isSessionLoadSupported()).toBe(true);
    await expect(store.listCreateOptions()).resolves.toEqual({
      workspaces: [{ path: '/Users/example/schema-19-project' }],
      models: [{ id: 'gpt-5-6-sol-medium' }],
    });
    await expect(store.loadSession('session-schema-19')).resolves.toEqual({
      sessionId: 'session-schema-19',
      cwd: '/Users/example/schema-19-project',
      modelId: 'gpt-5-6-sol-medium',
      messages: [
        { source: 'user', text: 'Read schema 19.' },
        { source: 'devin', text: 'Schema 19 is supported.' },
      ],
      truncated: false,
    });
    await store.stop();

    expect(await readFile(databasePath)).toEqual(before);
  });

  it('ignores an empty historical model without blocking workspaces or minimized history', async () => {
    const databasePath = join(directory, 'sessions.db');
    const database = createFixture(databasePath);
    database
      .prepare(
        `INSERT INTO sessions(
          id, working_directory, main_chain_id, model, agent_mode, last_activity_at, hidden
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-empty-model',
        '/Users/example/model-unavailable',
        1,
        '',
        'agent',
        '2026-07-12T12:00:00.000Z',
        0,
      );
    insertNode(database, {
      sessionId: 'session-empty-model',
      nodeId: 1,
      role: 'assistant',
      content: 'History remains available.',
    });
    database.close();
    await chmod(databasePath, 0o600);

    const store = new DevinSessionStore({ databasePath });
    await store.start();
    await expect(store.listCreateOptions()).resolves.toEqual({
      workspaces: [{ path: '/Users/example/model-unavailable' }],
      models: [],
    });
    await expect(store.loadSession('session-empty-model')).resolves.toEqual({
      sessionId: 'session-empty-model',
      cwd: '/Users/example/model-unavailable',
      messages: [{ source: 'devin', text: 'History remains available.' }],
      truncated: false,
    });
    await store.stop();
  });

  it('rejects a symbolic-link database path before opening SQLite', async () => {
    const databasePath = join(directory, 'sessions.db');
    const linkedPath = join(directory, 'linked.db');
    const database = createFixture(databasePath);
    database.close();
    await chmod(databasePath, 0o600);
    await symlink(databasePath, linkedPath);

    await expect(new DevinSessionStore({ databasePath: linkedPath }).start()).rejects.toThrow(
      'path is not trusted',
    );
  });
});

describe('Devin session store activity timeline', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'devinx-session-activity-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createTuiFixture(path: string): DatabaseSync {
    const database = createFixture(path, 17);
    database.exec(`
      CREATE TABLE tool_call_state (
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_call_json TEXT,
        tool_call_update_json TEXT,
        PRIMARY KEY(session_id, tool_call_id)
      );
    `);
    return database;
  }

  function addNode(
    database: DatabaseSync,
    input: {
      sessionId: string;
      nodeId: number;
      parentNodeId?: number;
      chatMessage: Record<string, unknown>;
    },
  ): void {
    database
      .prepare(
        `INSERT INTO message_nodes(session_id, node_id, parent_node_id, chat_message)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.nodeId,
        input.parentNodeId ?? null,
        JSON.stringify(input.chatMessage),
      );
  }

  function addState(
    database: DatabaseSync,
    sessionId: string,
    toolCallId: string,
    toolCall: Record<string, unknown>,
    update?: Record<string, unknown>,
  ): void {
    database
      .prepare(
        `INSERT INTO tool_call_state(session_id, tool_call_id, tool_call_json, tool_call_update_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        toolCallId,
        JSON.stringify(toolCall),
        update ? JSON.stringify(update) : null,
      );
  }

  const READ_CALL = 'call_read_1';
  const EDIT_CALL = 'call_edit_1';
  const EXEC_CALL = 'call_exec_1';
  const GREP_CALL = 'call_grep_1';

  function buildTuiSession(database: DatabaseSync, sessionId: string): void {
    const cwd = '/Users/tester/ws';
    database
      .prepare('INSERT INTO sessions(id, working_directory, main_chain_id) VALUES (?, ?, ?)')
      .run(sessionId, cwd, 10);
    addNode(database, {
      sessionId,
      nodeId: 1,
      chatMessage: { message_id: 'u1', role: 'user', content: 'Do the tasks.' },
    });
    addNode(database, {
      sessionId,
      nodeId: 2,
      parentNodeId: 1,
      chatMessage: {
        message_id: 'a1',
        role: 'assistant',
        content: '',
        thinking: { thinking: 'I will read the file first.', signature: 'sig' },
        tool_calls: [
          { id: READ_CALL, name: 'read', arguments: { file_path: `${cwd}/notes.txt` }, kind: 'function' },
        ],
        metadata: { finish_reason: 'tool_calls' },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 3,
      parentNodeId: 2,
      chatMessage: {
        message_id: 't1',
        role: 'tool',
        content: '  1|goodbye world\n  2|phase 11',
        tool_call_id: READ_CALL,
        metadata: {
          extensions: {
            'chisel/tool_result_meta': { success: true, kind: 'read' },
            'chisel/tool_call_timing': {
              started_at: '2026-09-27T21:32:32.513858Z',
              finished_at: '2026-09-27T21:32:32.513962Z',
            },
          },
        },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 4,
      parentNodeId: 3,
      chatMessage: {
        message_id: 'a2',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: EDIT_CALL,
            name: 'edit',
            arguments: { file_path: `${cwd}/notes.txt`, old_string: 'goodbye', new_string: 'farewell' },
            kind: 'function',
          },
        ],
        metadata: { finish_reason: 'tool_calls' },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 5,
      parentNodeId: 4,
      chatMessage: {
        message_id: 't2',
        role: 'tool',
        content: 'The file notes.txt has been updated.',
        tool_call_id: EDIT_CALL,
        metadata: {
          extensions: {
            'chisel/tool_result_meta': { success: true, kind: 'edit' },
          },
        },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 6,
      parentNodeId: 5,
      chatMessage: {
        message_id: 'a3',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: EXEC_CALL,
            name: 'exec',
            arguments: { command: 'sleep 1 && wc -l notes.txt' },
            kind: 'function',
          },
        ],
        metadata: { finish_reason: 'tool_calls' },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 7,
      parentNodeId: 6,
      chatMessage: {
        message_id: 't3',
        role: 'tool',
        content: '       2 notes.txt\n\nExit code: 0',
        tool_call_id: EXEC_CALL,
        metadata: {
          extensions: {
            'chisel/tool_result_meta': { success: true, kind: 'execute' },
          },
        },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 8,
      parentNodeId: 7,
      chatMessage: {
        message_id: 'a4',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: GREP_CALL, name: 'grep', arguments: { pattern: 'farewell' }, kind: 'function' },
        ],
        metadata: { finish_reason: 'tool_calls' },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 9,
      parentNodeId: 8,
      chatMessage: {
        message_id: 't4',
        role: 'tool',
        content: "Found 1 match(es) for pattern 'farewell'.",
        tool_call_id: GREP_CALL,
        metadata: { extensions: { 'chisel/tool_result_meta': { success: true, kind: 'search' } } },
      },
    });
    addNode(database, {
      sessionId,
      nodeId: 10,
      parentNodeId: 9,
      chatMessage: {
        message_id: 'a5',
        role: 'assistant',
        content: 'All done.',
        tool_calls: [],
        metadata: { finish_reason: 'stop' },
      },
    });
    addState(database, sessionId, READ_CALL, {
      toolCallId: READ_CALL,
      title: 'Read file',
      kind: 'read',
      locations: [{ path: `${cwd}/notes.txt` }],
      rawInput: { file_path: `${cwd}/notes.txt` },
    });
    addState(database, sessionId, EDIT_CALL, {
      toolCallId: EDIT_CALL,
      title: 'Edit file',
      kind: 'edit',
      content: [
        {
          type: 'diff',
          path: `${cwd}/notes.txt`,
          oldText: 'goodbye world\n',
          newText: 'farewell world\n',
        },
      ],
      locations: [{ path: `${cwd}/notes.txt` }],
    });
    addState(
      database,
      sessionId,
      EXEC_CALL,
      {
        toolCallId: EXEC_CALL,
        title: 'Ran sleep',
        kind: 'execute',
        content: [
          {
            type: 'content',
            content: {
              type: 'resource',
              resource: {
                mimeType: 'text/x-shellscript',
                text: 'sleep 1 && wc -l notes.txt',
                uri: 'tool://preview',
              },
            },
          },
        ],
        rawInput: { command: 'sleep 1 && wc -l notes.txt' },
      },
      { toolCallId: EXEC_CALL, status: 'completed' },
    );
    addState(database, sessionId, GREP_CALL, {
      toolCallId: GREP_CALL,
      title: "Search for 'farewell'",
      kind: 'search',
      locations: [{ path: '.' }],
    });
  }

  it('maps TUI nodes and tool_call_state into the activity timeline', async () => {
    const databasePath = join(directory, 'sessions.db');
    const writer = createTuiFixture(databasePath);
    const sessionId = 'session-tui';
    buildTuiSession(writer, sessionId);
    writer.close();
    await chmod(databasePath, 0o600);

    const store = new DevinSessionStore({ databasePath, isProcessAlive: () => false });
    await store.start();
    try {
      const loaded = await store.loadSession(sessionId);
      expect(loaded.messages.map((message) => message.text)).toEqual([
        'Do the tasks.',
        '',
        '',
        '',
        '',
        'All done.',
      ]);
      const activity = loaded.activity ?? [];
      expect(activity.map((entry) => entry.kind)).toEqual([
        'thought',
        'tool',
        'tool',
        'tool',
        'tool',
      ]);
      const [thought, read, edit, exec, search] = activity;
      expect(thought?.detail).toMatchObject({
        type: 'text',
        text: 'I will read the file first.',
      });
      expect(read).toMatchObject({
        toolKind: 'read',
        status: 'completed',
        title: 'Read file',
        paths: ['notes.txt'],
        startedAt: Date.parse('2026-09-27T21:32:32.513858Z'),
        endedAt: Date.parse('2026-09-27T21:32:32.513962Z'),
      });
      expect((read?.detail as { text: string }).text).toContain('goodbye world');
      expect(edit?.detail).toEqual({
        type: 'diff',
        path: 'notes.txt',
        oldText: 'goodbye world\n',
        newText: 'farewell world\n',
      });
      expect(exec).toMatchObject({ title: 'Ran sleep', toolKind: 'execute', status: 'completed' });
      const execText = (exec?.detail as { text: string }).text;
      expect(execText).toContain('$ sleep 1 && wc -l notes.txt');
      expect(execText).toContain('       2 notes.txt');
      expect(search).toMatchObject({
        title: "Search for 'farewell'",
        toolKind: 'search',
        status: 'completed',
      });
      expect(JSON.stringify(activity)).not.toContain('/Users/tester');
    } finally {
      await store.stop();
    }
  });

  it('completes persisted thoughts with real timestamps placed before the reply', async () => {
    const databasePath = join(directory, 'sessions.db');
    const writer = createTuiFixture(databasePath);
    const cwd = '/Users/tester/ws';
    writer
      .prepare('INSERT INTO sessions(id, working_directory, main_chain_id) VALUES (?, ?, ?)')
      .run('session-thought', cwd, 4);
    addNode(writer, {
      sessionId: 'session-thought',
      nodeId: 1,
      chatMessage: { message_id: 'u1', role: 'user', content: 'Fix it.' },
    });
    addNode(writer, {
      sessionId: 'session-thought',
      nodeId: 2,
      parentNodeId: 1,
      chatMessage: {
        message_id: 'a1',
        role: 'assistant',
        content: 'Done.',
        thinking: { thinking: 'Read first, then edit.', signature: 'sig' },
        tool_calls: [
          { id: 'call_x', name: 'read', arguments: { file_path: `${cwd}/notes.txt` }, kind: 'function' },
        ],
        metadata: {
          finish_reason: 'stop',
          started_generation_at: '2026-09-27T21:32:31.313571Z',
          created_at: '2026-09-27T21:32:32.506413Z',
        },
      },
    });
    addNode(writer, {
      sessionId: 'session-thought',
      nodeId: 3,
      parentNodeId: 2,
      chatMessage: {
        message_id: 't1',
        role: 'tool',
        content: 'contents',
        tool_call_id: 'call_x',
        metadata: { extensions: { 'chisel/tool_result_meta': { success: true, kind: 'read' } } },
      },
    });
    addNode(writer, {
      sessionId: 'session-thought',
      nodeId: 4,
      parentNodeId: 3,
      chatMessage: {
        message_id: 'a2',
        role: 'assistant',
        content: 'Reply.',
        metadata: { finish_reason: 'stop' },
      },
    });
    writer.close();
    await chmod(databasePath, 0o600);

    const store = new DevinSessionStore({ databasePath, isProcessAlive: () => false });
    await store.start();
    try {
      const loaded = await store.loadSession('session-thought');
      const activity = loaded.activity ?? [];
      const thought = activity.find((entry) => entry.kind === 'thought');
      const tool = activity.find((entry) => entry.kind === 'tool');
      expect(thought).toMatchObject({
        status: 'completed',
        startedAt: Date.parse('2026-09-27T21:32:31.313571Z'),
        endedAt: Date.parse('2026-09-27T21:32:32.506413Z'),
      });
      // The user message is sequence 1; the node's thought/tool work precedes
      // its own assistant text, so they attach at the same boundary.
      expect(thought?.afterSequence).toBe(1);
      expect(tool?.afterSequence).toBe(1);
      // Assistant a2 has no activity; nothing lands after the last message.
      expect(activity.every((entry) => entry.afterSequence === 1)).toBe(true);
    } finally {
      await store.stop();
    }
  });

  it('uses persisted timestamps for state-only tools and stays stable across reloads', async () => {
    const databasePath = join(directory, 'sessions.db');
    const writer = createTuiFixture(databasePath);
    const cwd = '/Users/tester/ws';
    writer
      .prepare('INSERT INTO sessions(id, working_directory, main_chain_id) VALUES (?, ?, ?)')
      .run('session-stateonly', cwd, 3);
    addNode(writer, {
      sessionId: 'session-stateonly',
      nodeId: 1,
      chatMessage: { message_id: 'u1', role: 'user', content: 'Try it.' },
    });
    addNode(writer, {
      sessionId: 'session-stateonly',
      nodeId: 2,
      parentNodeId: 1,
      chatMessage: {
        message_id: 'a1',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_fail', name: 'exec', arguments: { command: 'false' }, kind: 'function' },
          { id: 'call_open', name: 'exec', arguments: { command: 'sleep 9' }, kind: 'function' },
        ],
        metadata: {
          finish_reason: 'tool_calls',
          started_generation_at: '2026-09-27T21:32:31.000000Z',
          created_at: '2026-09-27T21:32:33.000000Z',
        },
      },
    });
    addNode(writer, {
      sessionId: 'session-stateonly',
      nodeId: 3,
      parentNodeId: 2,
      chatMessage: {
        message_id: 'a2',
        role: 'assistant',
        content: 'That failed.',
        metadata: { finish_reason: 'stop' },
      },
    });
    // tool_call_state marks one call failed with no tool-result node; the
    // other stays unresolved (dead lock -> interrupted).
    addState(
      writer,
      'session-stateonly',
      'call_fail',
      { toolCallId: 'call_fail', title: 'Ran false', kind: 'execute' },
      { toolCallId: 'call_fail', status: 'failed' },
    );
    addState(writer, 'session-stateonly', 'call_open', {
      toolCallId: 'call_open',
      title: 'Ran sleep',
      kind: 'execute',
    });
    writer.close();
    await chmod(databasePath, 0o600);

    const store = new DevinSessionStore({ databasePath, isProcessAlive: () => false });
    await store.start();
    try {
      const first = await store.loadSession('session-stateonly');
      const failed = (first.activity ?? []).find(
        (entry) => entry.toolKind === 'execute' && entry.status === 'failed',
      );
      const interrupted = (first.activity ?? []).find((entry) => entry.status === 'interrupted');
      // assistant metadata.created_at is the best recorded start time.
      expect(failed?.startedAt).toBe(Date.parse('2026-09-27T21:32:33.000000Z'));
      expect(failed?.endedAt).toBeUndefined();
      expect(interrupted?.startedAt).toBe(Date.parse('2026-09-27T21:32:33.000000Z'));
      expect(interrupted?.endedAt).toBeUndefined();

      const second = await store.loadSession('session-stateonly');
      expect(second.activity).toEqual(first.activity);
    } finally {
      await store.stop();
    }
  });

  it('skips unknown-shape nodes while keeping messages', async () => {
    const databasePath = join(directory, 'sessions.db');
    const writer = createTuiFixture(databasePath);
    writer
      .prepare('INSERT INTO sessions(id, working_directory, main_chain_id) VALUES (?, ?, ?)')
      .run('session-odd', '/tmp/ws', 3);
    addNode(writer, {
      sessionId: 'session-odd',
      nodeId: 1,
      chatMessage: { message_id: 'u1', role: 'user', content: 'Hello.' },
    });
    writer
      .prepare(
        `INSERT INTO message_nodes(session_id, node_id, parent_node_id, chat_message)
         VALUES ('session-odd', 2, 1, 'not json{')`,
      )
      .run();
    addNode(writer, {
      sessionId: 'session-odd',
      nodeId: 3,
      parentNodeId: 2,
      chatMessage: { message_id: 'a1', role: 'assistant', content: 'Hi there.' },
    });
    writer.close();
    await chmod(databasePath, 0o600);

    const store = new DevinSessionStore({ databasePath });
    await store.start();
    try {
      const loaded = await store.loadSession('session-odd');
      expect(loaded.messages.map((message) => message.text)).toEqual(['Hello.', 'Hi there.']);
      expect(loaded.truncated).toBe(true);
    } finally {
      await store.stop();
    }
  });

  describe('getSessionLiveness', () => {
    const sessionId = 'session-live';

    async function fixtureWithTip(tip: Record<string, unknown>, lastActivitySeconds = 1_800_000_000) {
      const databasePath = join(directory, 'sessions.db');
      const writer = createTuiFixture(databasePath);
      writer
        .prepare(
          `INSERT INTO sessions(id, working_directory, main_chain_id, last_activity_at)
           VALUES (?, '/tmp/ws', 1, ?)`,
        )
        .run(sessionId, lastActivitySeconds);
      addNode(writer, { sessionId, nodeId: 1, chatMessage: tip });
      writer.close();
      await chmod(databasePath, 0o600);
      return databasePath;
    }

    async function lockFile(pid: number | string): Promise<string> {
      const lockDirectory = join(directory, `locks-${Math.random().toString(36).slice(2)}`);
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(join(lockDirectory, `${sessionId}.lock`), String(pid));
      return lockDirectory;
    }

    it('reports active thinking when a live lock owns a user tip', async () => {
      const databasePath = await fixtureWithTip({
        message_id: 'u1',
        role: 'user',
        content: 'Work.',
      });
      const lockDirectory = await lockFile(424_242);
      const store = new DevinSessionStore({
        databasePath,
        lockDirectory,
        isProcessAlive: () => true,
      });
      await store.start();
      try {
        await expect(store.getSessionLiveness(sessionId)).resolves.toEqual({
          active: true,
          kind: 'thinking',
          updatedAt: 1_800_000_000_000,
        });
      } finally {
        await store.stop();
      }
    });

    it('reports active executing for an unresolved exec tool call', async () => {
      const databasePath = await fixtureWithTip({
        message_id: 'a1',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_pending', name: 'exec', arguments: {}, kind: 'function' }],
        metadata: { finish_reason: 'tool_calls' },
      });
      const lockDirectory = await lockFile(424_242);
      const store = new DevinSessionStore({
        databasePath,
        lockDirectory,
        isProcessAlive: () => true,
      });
      await store.start();
      try {
        const liveness = await store.getSessionLiveness(sessionId);
        expect(liveness).toMatchObject({ active: true, kind: 'executing' });
      } finally {
        await store.stop();
      }
    });

    it('reports inactive for a finished assistant tip even with a live lock', async () => {
      const databasePath = await fixtureWithTip({
        message_id: 'a1',
        role: 'assistant',
        content: 'Done.',
        tool_calls: [],
        metadata: { finish_reason: 'stop' },
      });
      const lockDirectory = await lockFile(424_242);
      const store = new DevinSessionStore({
        databasePath,
        lockDirectory,
        isProcessAlive: () => true,
      });
      await store.start();
      try {
        await expect(store.getSessionLiveness(sessionId)).resolves.toMatchObject({
          active: false,
        });
      } finally {
        await store.stop();
      }
    });

    it('reports inactive for a dead lock PID', async () => {
      const databasePath = await fixtureWithTip({
        message_id: 'u1',
        role: 'user',
        content: 'Work.',
      });
      const lockDirectory = await lockFile(424_242);
      const store = new DevinSessionStore({
        databasePath,
        lockDirectory,
        isProcessAlive: () => false,
      });
      await store.start();
      try {
        // A dead lock short-circuits before SQLite opens.
        await expect(store.getSessionLiveness(sessionId)).resolves.toBeNull();
      } finally {
        await store.stop();
      }
    });

    it('reports inactive for a stale user tip even with a live lock', async () => {
      const staleSeconds = Math.floor(Date.now() / 1000) - 31 * 60;
      const databasePath = await fixtureWithTip(
        { message_id: 'u1', role: 'user', content: 'Work.' },
        staleSeconds,
      );
      const lockDirectory = await lockFile(424_242);
      const store = new DevinSessionStore({
        databasePath,
        lockDirectory,
        isProcessAlive: () => true,
      });
      await store.start();
      try {
        await expect(store.getSessionLiveness(sessionId)).resolves.toMatchObject({
          active: false,
        });
      } finally {
        await store.stop();
      }
    });

    it('reports inactive when no lock file exists', async () => {
      const databasePath = await fixtureWithTip({
        message_id: 'u1',
        role: 'user',
        content: 'Work.',
      });
      const store = new DevinSessionStore({ databasePath });
      await store.start();
      try {
        await expect(store.getSessionLiveness(sessionId)).resolves.toBeNull();
      } finally {
        await store.stop();
      }
    });

    it('never opens SQLite when no lock file exists', async () => {
      const databasePath = await fixtureWithTip({
        message_id: 'u1',
        role: 'user',
        content: 'Work.',
      });
      let opens = 0;
      const store = new DevinSessionStore({
        databasePath,
        openDatabase: (path) => {
          opens += 1;
          return new DatabaseSync(path, { readOnly: true });
        },
      });
      await store.start();
      opens = 0;
      try {
        await expect(store.getSessionLiveness(sessionId)).resolves.toBeNull();
        expect(opens).toBe(0);
      } finally {
        await store.stop();
      }
    });

    it('opens SQLite exactly once for a live lock', async () => {
      const databasePath = await fixtureWithTip({
        message_id: 'u1',
        role: 'user',
        content: 'Work.',
      });
      const lockDirectory = await lockFile(424_242);
      let opens = 0;
      const store = new DevinSessionStore({
        databasePath,
        lockDirectory,
        isProcessAlive: () => true,
        openDatabase: (path) => {
          opens += 1;
          return new DatabaseSync(path, { readOnly: true });
        },
      });
      await store.start();
      opens = 0;
      try {
        await expect(store.getSessionLiveness(sessionId)).resolves.toMatchObject({
          active: true,
        });
        expect(opens).toBe(1);
      } finally {
        await store.stop();
      }
    });

    it('reports inactive for an assistant tip whose tool calls are all resolved', async () => {
      // The assistant tip must be the newest row; its tool nodes precede it.
      const databasePath = join(directory, 'sessions.db');
      const writer = createTuiFixture(databasePath);
      writer
        .prepare(
          `INSERT INTO sessions(id, working_directory, main_chain_id, last_activity_at)
           VALUES (?, '/tmp/ws', 3, ?)`,
        )
        .run(sessionId, 1_800_000_000);
      addNode(writer, {
        sessionId,
        nodeId: 1,
        chatMessage: { role: 'tool', content: 'ok', tool_call_id: 'call_done_1' },
      });
      addNode(writer, {
        sessionId,
        nodeId: 2,
        parentNodeId: 1,
        chatMessage: { role: 'tool', content: 'ok', tool_call_id: 'call_done_2' },
      });
      addNode(writer, {
        sessionId,
        nodeId: 3,
        parentNodeId: 2,
        chatMessage: {
          message_id: 'a1',
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_done_1', name: 'exec', arguments: {}, kind: 'function' },
            { id: 'call_done_2', name: 'read', arguments: {}, kind: 'function' },
          ],
          metadata: { finish_reason: 'tool_calls' },
        },
      });
      writer.close();
      await chmod(databasePath, 0o600);
      const lockDirectory = await lockFile(424_242);
      const store = new DevinSessionStore({
        databasePath,
        lockDirectory,
        isProcessAlive: () => true,
      });
      await store.start();
      try {
        await expect(store.getSessionLiveness(sessionId)).resolves.toMatchObject({
          active: false,
        });
      } finally {
        await store.stop();
      }
    });
  });
});
