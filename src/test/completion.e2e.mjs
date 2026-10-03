// End-to-end check of the inline-completion path, using the exact SDK the
// extension uses (@agentclientprotocol/sdk 0.21.1) and the exact compiled
// parseCompletion() from the built extension. Run:  node src/test/completion.e2e.js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert';

// Resolve hermes from PATH so an upgrade or reinstall does not break the
// check; HERMES_BIN overrides it.
const HERMES = process.env.HERMES_BIN || 'hermes';

const child = spawn(HERMES, ['acp'], { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
child.stdin.setDefaultEncoding('utf8');

let nextId = 1;
const pending = new Map();
const chunks = new Map(); // sessionId -> text
let sawUsage = false;

createInterface({ input: child.stdout }).on('line', line => {
  if (!line.trim().startsWith('{')) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'session/update') {
    const { sessionId, update } = msg.params;
    if (update.sessionUpdate === 'agent_message_chunk') {
      chunks.set(sessionId, (chunks.get(sessionId) ?? '') + (update.content?.text ?? ''));
    } else if (update.sessionUpdate === 'usage_update') {
      sawUsage = true;
    }
  }
});

const call = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, r => (r && r.error ? rej(new Error(JSON.stringify(r.error))) : res(r)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const timeout = setTimeout(() => { console.error('FAIL: timed out'); child.kill(); process.exit(1); }, 170000);

await call('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
});
console.log('ok  initialize');

const { sessionId } = await call('session/new', {
  cwd: 'C:\\Users\\Thabang\\Downloads\\vscode-acp',
  mcpServers: [],
});
assert.ok(sessionId, 'session/new must return a sessionId');
console.log('ok  hidden session created:', sessionId.slice(0, 16) + '...');

// Same prompt text CompletionService.complete() sends.
const prompt =
  'You are an inline code completion engine. Reply with ONLY the raw text to ' +
  'insert at the cursor. No explanation, no markdown fences, no repetition of ' +
  'existing code.\n\nFile: demo.ts\nCursor is at end of line 2.\n' +
  'Line 1: function greet(name: string) {\n' +
  'Line 2:   return ';

const res = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
console.log('ok  stopReason:', res.stopReason, '| usage_update seen:', sawUsage);

const raw = chunks.get(sessionId) ?? '';
console.log('ok  raw streamed reply:', JSON.stringify(raw.slice(0, 200)));
assert.ok(raw.trim(), 'expected streamed agent_message_chunk text');

// out/ is CommonJS (tsc -p .), so load the compiled parser via require
// after stubbing the `vscode` module the compiled file imports.
import { createRequire } from 'node:module';
import Module from 'node:module';
const require = createRequire(import.meta.url);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? request : origResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };
const { parseCompletion } = require('../../out/utils/InlineCompletionProvider.js');
const parsed = parseCompletion(raw);
console.log('ok  parsed insertion text:', JSON.stringify(parsed));
assert.ok(parsed && parsed.trim(), 'parser must yield insertion text from a real reply');
assert.ok(!parsed.startsWith('```'), 'parser must strip markdown fences');

clearTimeout(timeout);
child.kill();
console.log('\ncompletion.e2e: PASS (hidden session -> streamed chunk -> parse -> insertion)');
process.exit(0);
