import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpSessionClient, type AcpPermissionOption } from '../../bridge/src/acp';

export const options = [
  { optionId: 'once', kind: 'allow_once', name: 'Once' },
  { optionId: 'allow_session', kind: 'allow_always', name: 'This session' },
  { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
];
export async function fakeAcp(
  configuration: {
    permission?: boolean;
    title?: string;
    command?: string;
    reply?: string;
    elicitation?: boolean;
    stderr?: boolean;
    options?: AcpPermissionOption[];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'otterin-ai-eval-'));
  const executablePath = join(directory, 'fake-acp');
  const log = join(directory, 'events.jsonl');
  const fixture = { options, ...configuration };
  writeFileSync(
    executablePath,
    String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const fixture = ${JSON.stringify(fixture)};
const log = ${JSON.stringify(log)};
const record = data => fs.appendFileSync(log, JSON.stringify(data) + '\n');
if (process.argv[2] !== 'acp') process.exit(91);
record({envNames: Object.keys(process.env).sort()});
const send = data => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...data}) + '\n');
const modes = {currentModeId:'normal', availableModes:[{id:'normal',name:'Normal'},{id:'bypass',name:'Bypass'}]};
let input = '';
process.stdin.on('data', chunk => {
 input += chunk.toString(); const lines = input.split(/\r?\n/); input = lines.pop();
 for (const line of lines) {
  if (!line.trim()) continue;
  const r = JSON.parse(line); record(r);
  if (r.method === 'initialize') send({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},close:{}},promptCapabilities:{embeddedContext:true}}}});
  else if (r.method === 'session/list') send({id:r.id,result:{sessions:[{sessionId:'session-eval',cwd:${JSON.stringify(directory)}}]}});
  else if (r.method === 'session/load' || r.method === 'session/new') send({id:r.id,result:{sessionId:'session-eval',modes}});
  else if (r.method === 'session/set_mode') { modes.currentModeId=r.params.modeId; send({id:r.id,result:{}}); }
  else if (r.method === 'session/close') send({id:r.id,result:{}});
  else if (r.method === 'session/prompt') {
    if (fixture.stderr) {process.stderr.write('SYNTHETIC-SECRET /synthetic/private/path'); send({id:r.id,error:{code:-32000,message:'SYNTHETIC-SECRET /synthetic/private/path'}}); continue;}
    send({method:'session/update',params:{sessionId:'session-eval',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:fixture.reply || 'fixture reply'}}}});
    if (fixture.permission) send({id:'permission-rpc',method:'session/request_permission',params:{sessionId:'session-eval',toolCall:{toolCallId:'call-1',title:fixture.title || 'Run fixture',kind:'execute',rawInput:{command:fixture.command || 'echo fixture'}},options:fixture.options}});
    else if (fixture.elicitation) send({id:'question-rpc',method:'elicitation/create',params:{mode:'form',sessionId:'session-eval',message:'Choose fixture',requestedSchema:{type:'object',properties:{choice:{type:'string',enum:['safe','other']}},required:['choice']}}});
    else send({id:r.id,result:{stopReason:'end_turn'}});
  }
 }
});
`,
    { encoding: 'utf8' },
  );
  chmodSync(executablePath, 0o700);
  const client = new AcpSessionClient({
    executablePath,
    requestTimeoutMs: 1000,
    promptTimeoutMs: 5000,
    permissionTimeoutMs: 1000,
  });
  const events = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  try {
    await client.start();
    await client.listSessions();
    await client.loadSession('session-eval');
  } catch (error) {
    await client.stop();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    client,
    directory,
    events,
    close: async () => {
      await client.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function until<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 4000;
  let value = await read();
  while (!ready(value)) {
    if (Date.now() > deadline) throw new Error('Fake ACP fixture did not reach requested state');
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
}
