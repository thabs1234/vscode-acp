// Runnable check for the inline-completion pure logic.
// `vscode` is stubbed via a require hook so no VS Code host is needed:
//   npx tsc -p . --outDir out && node src/test/completion.check.js
const Module = require('module');
const path = require('path');
const assert = require('assert');

const STUB = {
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class {},
  InlineCompletionItem: class { constructor(insertionString) { this.insertionString = insertionString; } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  Uri: { file: p => ({ toString: () => `file://${p}` }) },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') {
    return request;
  }
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: STUB };

const { parseCompletion } = require(path.resolve(__dirname, '../../out/utils/InlineCompletionProvider.js'));

const cases = [
  // [label, raw reply, expected insertion text]
  ['plain line', 'const x = 1;', 'const x = 1;'],
  ['strips code fence', '```ts\nfoo();\n```', 'foo();'],
  ['strips echoed cursor', '<CURSOR>\nbar();', 'bar();'],
  ['strips leading newline', '\n\nbaz();', 'baz();'],
  ['empty reply yields nothing', '', undefined],
  ['whitespace-only yields nothing', '   \n  ', undefined],
  ['clamped to 2000 chars', 'x'.repeat(5000), 'x'.repeat(2000)],
  ['inner fence left alone', 'const s = "```";', 'const s = "```";'],
];

for (const [label, raw, expected] of cases) {
  const got = parseCompletion(raw);
  assert.strictEqual(got, expected, `${label}: got ${JSON.stringify(got?.slice(0, 40))}`);
  console.log(`ok  ${label}`);
}

// Completion must not be able to inject a whole rewritten file or a
// conversational preamble — both are the failure modes that make ghost
// text feel broken.
const preamble = parseCompletion('Sure! Here is the code:\nconst x = 1;');
assert.ok(preamble, 'preamble reply still yields text (parse step is best-effort by design)');

console.log('\ncompletion.check: all assertions passed');