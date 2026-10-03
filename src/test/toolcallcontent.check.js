// Regression check for ACP tool-call content rendering (issue #69).
//
// renderToolContent lives inside the webview HTML template, so it is not
// importable. Rather than refactor production code for testability, this
// extracts the real function source out of ChatWebviewProvider.ts and runs it.
// If the function is renamed or removed, this fails loudly instead of silently
// passing against a stale copy.
//
//   node src/test/toolcallcontent.check.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
  path.resolve(__dirname, '../ui/ChatWebviewProvider.ts'),
  'utf8'
);

const start = src.indexOf('function renderToolContent(');
assert.ok(start !== -1, 'renderToolContent no longer exists in ChatWebviewProvider.ts');

// Walk braces to find the end of the function (naive, but the body has no
// braces inside strings that would confuse the count).
let depth = 0;
let end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}
assert.ok(end !== -1, 'could not find end of renderToolContent');

const fn = vm.runInNewContext(src.slice(start, end) + '; renderToolContent');
const render = fn;

// ACP nests the content block one level deep, so the inner .text must be read.
// A direct ContentBlock[] read would yield nothing here.
const acp = text => [{ type: 'content', content: { type: 'text', text } }];

const cases = [
  ['nested text block', acp('read 42 lines'), 'read 42 lines'],
  ['single text block', acp('ok'), 'ok'],
  ['empty array', [], ''],
  ['missing content', undefined, ''],
  ['null entry ignored', [null, ...acp('kept')], 'kept'],
  ['non-text labelled', [{ type: 'content', content: { type: 'image' } }], '[image]'],
  ['diff summarised', [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'x\ny' }], 'diff a.ts (1 -> 2 lines)'],
  ['terminal labelled', [{ type: 'terminal', terminalId: 'term1' }], 'terminal term1'],
  ['unknown kind labelled', [{ type: 'weird' }], '[weird]'],
  ['multiple blocks joined', [...acp('one'), ...acp('two')], 'one\ntwo'],
  ['empty text block skipped', acp(''), ''],
  ['null text block skipped', acp(null), ''],
  ['zero renders as 0', acp(0), '0'],
  ['numeric text coerced', acp(42), '42'],
  ['boolean text coerced', acp(false), 'false'],
  ['markup stays as text', acp('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>'],
];

for (const [label, input, expected] of cases) {
  assert.strictEqual(render(input), expected, label);
}

// Updates that omit content must not blank out text already on screen.
assert.strictEqual(render(undefined), '', 'omitted content yields empty string');

// Content must never reach innerHTML unescaped. render deliberately leaves
// markup alone, so escaping is the only thing standing between agent output
// and the webview DOM.
const provider = fs.readFileSync(
  path.resolve(__dirname, '../ui/ChatWebviewProvider.ts'),
  'utf8'
);
assert.ok(
  provider.includes('escapeHtml(contentText)'),
  'tool-call content must be escaped before insertion into the DOM'
);
assert.ok(
  !/innerHTML\s*=.*contentText\s*(?<!escapeHtml\().*$/m.test(provider),
  'contentText must not be assigned to innerHTML unescaped'
);

console.log('toolcallcontent.check: PASS (' + cases.length + ' cases)');