// Probe: does the ACP client agent config's likely command actually serve ACP?
// Checks the exact path we are about to write into settings.json acp.agents.
// Run: node src/test/acp.probe.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const HERMES = 'C:\\Users\\Thabang\\AppData\\Local\\hermes\\bin\\hermes.exe';

const child = spawn(HERMES, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
let err = '';
child.stderr.on('data', d => { err += d.toString(); });

let nextId = 1;
const pending = new Map();

createInterface({ input: child.stdout }).on('line', line => {
  if (!line.trim().startsWith('{')) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  }
});

const call = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, r => (r && r.error ? rej(new Error(JSON.stringify(r.error))) : res(r)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const timer = setTimeout(() => {
  console.error('FAIL: timed out\n' + err.slice(-500));
  child.kill();
  process.exit(1);
}, 300000);

try {
  const init = await call('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log('ok  initialize -> protocolVersion', init?.protocolVersion, '| agents:',
    (init?.agentCapabilities ? 'yes' : 'n/a'));

  const { sessionId } = await call('session/new', {
    cwd: 'C:\\Users\\Thabang\\Downloads\\vscode-acp',
    mcpServers: [],
  });
  if (!sessionId) throw new Error('no sessionId from session/new');
  console.log('ok  session/new ->', sessionId.slice(0, 8) + '...');

  clearTimeout(timer);
  child.kill();
  console.log('acp.probe: PASS (' + HERMES + ' acp)');
  process.exit(0);
} catch (e) {
  console.error('acp.probe: FAIL', e.message, '\n' + err.slice(-500));
  child.kill();
  process.exit(1);
}