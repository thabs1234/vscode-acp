import * as vscode from 'vscode';

/**
 * Copilot-style ghost-text inline completion, backed by the connected ACP
 * agent (Hermes).
 *
 * Design constraints:
 *  - Completions never enter the visible chat. Completions run on a
 *    dedicated hidden ACP session kept out of the session tree/history.
 *  - A new keystroke aborts the in-flight request (AbortController), so we
 *    never render stale ghost text after the user has moved on.
 *  - Requests are serialised through a queue so a burst of keystrokes
 *    cannot interleave two prompts on the same hidden session.
 *  - Cached per (file, line, prefix) with an LRU bound, so repeated
 *    keystrokes in already-seen code cost nothing.
 *
 * ponytail: single agent, no cross-file context, no FIM-style prompt.
 * Upgrade path: prefix the prompt with the active selection and open
 * editors, and fan out to whichever agent the user has focused.
 */

const CACHE_MAX = 256;
const MIN_PREFIX_LEN = 12;
const MAX_INSERT_CHARS = 2000;
const REQUEST_TIMEOUT_MS = 8000;

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new Map<string, string>();
  private inFlight: AbortController | null = null;
  private queued: Promise<unknown> = Promise.resolve();
  private disposed = false;

  /** @param sendPrompt Runs one completion prompt on a hidden ACP session. */
  constructor(private readonly sendPrompt: (text: string) => Promise<string>) {}

  /** Drop cached completions when the active agent/session changes. */
  onAgentChanged(): void {
    this.cache.clear();
    this.inFlight?.abort();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    if (this.disposed) {
      return [];
    }
    // The user's new keystroke is what cancels this request.
    const abort = token.onCancellationRequested(() => this.inFlight?.abort());
    try {
      return this.toItems(await this.complete(document, position));
    } finally {
      abort.dispose();
    }
  }

  /**
   * Resolve the ghost text for this cursor position.
   * Returns '' when there is nothing useful to show.
   */
  async complete(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
    // Prose files: ghost text is noise, not a code completion.
    if (document.languageId === 'markdown' || document.languageId === 'plaintext') {
      return '';
    }

    const prefix = document.getText(
      new vscode.Range(new vscode.Position(position.line, 0), position),
    );
    if (prefix.trim().length < MIN_PREFIX_LEN) {
      return '';
    }

    const key = `${document.uri.toString()}:${position.line}:${position.character}:${prefix.length}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU recency
      this.cache.set(key, hit);
      return hit;
    }

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    const prompt = buildPrompt(document, position, prefix);
    const completion = await this.enqueue(async () => {
      if (controller.signal.aborted) {
        return undefined;
      }
      let raw: string;
      try {
        raw = await withTimeout(this.sendPrompt(prompt), REQUEST_TIMEOUT_MS);
      } catch {
        return undefined; // agent busy or unavailable: no ghost text, no error popup
      }
      if (controller.signal.aborted) {
        return undefined;
      }
      const parsed = parseCompletion(raw);
      if (parsed) {
        this.cachePut(key, parsed);
      }
      return parsed;
    });

    return completion ?? '';
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.inFlight?.abort();
  }

  /** One queue slot: requests never run concurrently on the hidden session. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queued.then(fn, fn);
    // Swallow rejections so one failure cannot poison the queue.
    this.queued = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private cachePut(key: string, value: string): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  private toItems(text: string): vscode.InlineCompletionItem[] {
    if (!text) {
      return [];
    }
    return [new vscode.InlineCompletionItem(text)];
  }
}

function buildPrompt(
  document: vscode.TextDocument,
  position: vscode.Position,
  prefix: string,
): string {
  const fileName = document.fileName.split(/[\\/]/).pop() ?? document.fileName;
  return [
    'You are an inline code-completion engine. Reply with ONLY the raw',
    'completion text. No prose, no markdown fences, no explanation.',
    '',
    `File: ${fileName}`,
    `Language: ${document.languageId}`,
    '',
    'Continue the code at the <CURSOR> marker. Continue the current line if',
    'the cursor is mid-line, otherwise begin the next line. Emit only what',
    'should be inserted at the cursor, not the whole file.',
    '',
    '--- BEGIN FILE ---',
    prefix,
    '<CURSOR>',
    '--- END FILE ---',
  ].join('\n');
}

/** Turn the model's raw reply into insertion text, or undefined to skip. */
export function parseCompletion(raw: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  let text = raw;

  // Models sometimes wrap output in fences despite instructions.
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) {
    text = fenced[1];
  }

  // Drop an echoed cursor marker.
  text = text.replace(/^\s*<CURSOR>\s*/i, '');

  // A leading newline just means the model started a fresh line; the
  // cursor position already encodes that.
  text = text.replace(/^\n+/, '');

  if (!text.trim()) {
    return undefined;
  }
  return text.length > MAX_INSERT_CHARS ? text.slice(0, MAX_INSERT_CHARS) : text;
}

/** Reject rather than hang when the agent never answers. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('completion timeout')), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}