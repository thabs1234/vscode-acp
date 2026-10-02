import * as vscode from 'vscode';
import { ConnectionManager } from '../core/ConnectionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import { InlineCompletionProvider } from './InlineCompletionProvider';
import { log, logError } from './Logger';

import type { SessionNotification } from '@agentclientprotocol/sdk';

/**
 * Wires Copilot-style ghost-text completion to the connected ACP agent.
 *
 * The completion session is deliberately NOT registered in SessionManager:
 * it is created straight from ConnectionManager so it never appears in the
 * session tree, the chat history, or `getActiveSessionId()`. Inline
 * completions are a side channel and must not contaminate the conversation.
 *
 * The agent streams its reply as `agent_message_chunk` notifications and
 * returns only a stopReason from `prompt()`, so the reply text is collected
 * from the update stream — filtered strictly to our own hidden sessionId so
 * a visible chat turn running at the same time cannot bleed into ghost text.
 *
 * ponytail: one completion session per window, reused until the agent
 * connection dies. Upgrade path: one per workspace folder, and re-create on
 * cwd change, for cwd-sensitive models.
 */
export class CompletionService implements vscode.Disposable {
  private readonly provider: InlineCompletionProvider;
  private readonly listener: SessionUpdateListener;
  private registration: vscode.Disposable | undefined;
  private sessionId: string | null = null;
  private starting: Promise<string | null> | null = null;
  /** Reply text for the in-flight prompt on the hidden session. */
  private buffer = '';
  private collecting = false;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    this.provider = new InlineCompletionProvider(text => this.complete(text));
    this.listener = (update: SessionNotification) => this.onUpdate(update);
  }

  activate(): void {
    this.sessionUpdateHandler.addListener(this.listener);
    this.registration = vscode.languages.registerInlineCompletionItemProvider(
      { scheme: 'file', pattern: '**/*' },
      this.provider,
    );
    log('CompletionService: inline completion provider registered');
  }

  /** Drop cached ghost text when the user switches agent. */
  onAgentChanged(): void {
    this.provider.onAgentChanged();
  }

  dispose(): void {
    this.registration?.dispose();
    this.sessionUpdateHandler.removeListener(this.listener);
    this.provider.dispose();
  }

  /** True once the hidden session exists — used by the smoke check. */
  isReady(): boolean {
    return this.sessionId !== null;
  }

  /**
   * Run one completion prompt on the hidden session and return the reply.
   * Creates the session on first use.
   */
  private async complete(text: string): Promise<string> {
    const sessionId = await this.ensureSession();
    if (!sessionId) {
      return '';
    }
    const agentId = this.currentAgentId();
    const connInfo = agentId ? this.connectionManager.getConnection(agentId) : undefined;
    if (!connInfo) {
      return '';
    }

    this.buffer = '';
    this.collecting = true;
    try {
      await connInfo.connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    } catch (e) {
      logError('Inline completion prompt failed', e);
    } finally {
      this.collecting = false;
    }
    return this.buffer;
  }

  /**
   * Accumulate agent_message_chunk text for our hidden session only.
   * Thought and tool_call chunks are ignored: we only want prose the parse
   * step can turn into insertion text.
   */
  private onUpdate(update: SessionNotification): void {
    if (!this.collecting || update.sessionId !== this.sessionId) {
      return;
    }
    const data = update.update as any;
    if (data?.sessionUpdate !== 'agent_message_chunk') {
      return;
    }
    const chunk = data.content;
    const text = typeof chunk === 'string' ? chunk : chunk?.text;
    if (typeof text === 'string') {
      this.buffer += text;
    }
  }

  /**
   * Lazily create the hidden completion session. Concurrent callers share
   * one in-flight start so we never spawn two sessions.
   */
  private ensureSession(): Promise<string | null> {
    if (this.sessionId) {
      return Promise.resolve(this.sessionId);
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startSession()
      .then(id => {
        if (id) {
          this.sessionId = id;
        }
        return id;
      })
      .catch(e => {
        logError('Failed to create inline completion session', e);
        return null;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async startSession(): Promise<string | null> {
    const agentId = this.currentAgentId();
    const connInfo = agentId ? this.connectionManager.getConnection(agentId) : undefined;
    if (!connInfo) {
      return null;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const res = await connInfo.connection.newSession({ cwd, mcpServers: [] });
    return res.sessionId;
  }

  /**
   * Agent backing the active chat, so completions follow the user's choice.
   */
  private currentAgentId(): string | undefined {
    return this.connectionManager.getAnyConnectedAgentId();
  }
}
