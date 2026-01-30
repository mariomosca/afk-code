/**
 * SDK Session Wrapper for AFK-Code
 *
 * Wraps @anthropic-ai/claude-agent-sdk query() for Telegram integration.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  SDKMessage,
  SDKOptions,
  CanUseTool,
  PermissionResult,
  SDKSessionState,
  PendingApproval,
} from './types.js';

export interface SDKSessionConfig {
  /** Working directory for the session */
  cwd: string;
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Tools to allow without prompting */
  allowedTools?: string[];
  /** Custom canUseTool handler */
  canUseTool?: CanUseTool;
  /** Called when a message is received */
  onMessage?: (message: SDKMessage) => void;
  /** Called when session ends */
  onEnd?: (result: { success: boolean; error?: string }) => void;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

const SAFE_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch'];

export class SDKSession {
  private query: Query | null = null;
  private abortController: AbortController | null = null;
  private state: SDKSessionState | null = null;
  private config: SDKSessionConfig;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(config: SDKSessionConfig) {
    this.config = config;
  }

  get sessionId(): string | null {
    return this.state?.sessionId ?? null;
  }

  get isActive(): boolean {
    return this.state?.isActive ?? false;
  }

  /**
   * Start a new query session
   */
  async start(prompt: string): Promise<void> {
    if (this.query) {
      throw new Error('Session already active. Call close() first.');
    }

    this.abortController = new AbortController();

    const options: SDKOptions = {
      cwd: this.config.cwd,
      model: this.config.model ?? DEFAULT_MODEL,
      allowedTools: this.config.allowedTools ?? SAFE_TOOLS,
      canUseTool: this.config.canUseTool,
      abortController: this.abortController,
    };

    this.query = query({ prompt, options });

    this.state = {
      sessionId: '',
      isActive: true,
      cwd: this.config.cwd,
      model: options.model ?? DEFAULT_MODEL,
      startedAt: new Date(),
    };

    // Process messages in background
    this.processMessages().catch((err) => {
      console.error('[SDKSession] Error processing messages:', err);
      this.config.onEnd?.({ success: false, error: err.message });
    });
  }

  /**
   * Process incoming messages from the query
   */
  private async processMessages(): Promise<void> {
    if (!this.query) return;

    try {
      for await (const message of this.query) {
        // Update session ID from init message
        if (message.type === 'system' && message.subtype === 'init') {
          if (this.state) {
            this.state.sessionId = message.session_id;
          }
        }

        // Notify listener
        this.config.onMessage?.(message);

        // Handle result message (session complete)
        if (message.type === 'result') {
          if (this.state) {
            this.state.isActive = false;
          }
          const success = message.subtype === 'success';
          this.config.onEnd?.({
            success,
            error: success ? undefined : (message as any).error,
          });
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.config.onEnd?.({ success: true });
      } else {
        throw err;
      }
    }
  }

  /**
   * Send follow-up message to the session
   */
  async send(message: string): Promise<void> {
    if (!this.query || !this.state?.isActive) {
      throw new Error('No active session. Call start() first.');
    }

    // Create user message for streaming input
    const userMessage = {
      type: 'user' as const,
      message: { role: 'user' as const, content: message },
      parent_tool_use_id: null,
      session_id: this.state.sessionId,
    };

    // Use streamInput to send follow-up messages
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield userMessage;
      },
    };

    await this.query.streamInput(asyncIterable);
  }

  /**
   * Interrupt the current query
   */
  async interrupt(): Promise<void> {
    if (this.query) {
      await this.query.interrupt();
    }
  }

  /**
   * Close the session
   */
  close(): void {
    if (this.query) {
      this.query.close();
      this.query = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.state) {
      this.state.isActive = false;
    }

    // Clear pending approvals
    for (const approval of this.pendingApprovals.values()) {
      clearTimeout(approval.timeout);
      approval.resolve({ behavior: 'deny', message: 'Session closed' });
    }
    this.pendingApprovals.clear();
  }

  /**
   * Register a pending tool approval
   */
  registerPendingApproval(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    telegramMessageId: number,
    resolve: (result: PermissionResult) => void,
    timeoutMs = 60000
  ): void {
    const timeout = setTimeout(() => {
      this.pendingApprovals.delete(toolUseId);
      resolve({ behavior: 'deny', message: 'Approval timeout' });
    }, timeoutMs);

    this.pendingApprovals.set(toolUseId, {
      toolUseId,
      toolName,
      input,
      telegramMessageId,
      resolve,
      timeout,
    });
  }

  /**
   * Resolve a pending approval
   */
  resolvePendingApproval(
    toolUseId: string,
    approved: boolean,
    message?: string
  ): boolean {
    const approval = this.pendingApprovals.get(toolUseId);
    if (!approval) return false;

    clearTimeout(approval.timeout);
    this.pendingApprovals.delete(toolUseId);

    if (approved) {
      approval.resolve({ behavior: 'allow', updatedInput: approval.input });
    } else {
      approval.resolve({ behavior: 'deny', message: message ?? 'User denied' });
    }

    return true;
  }

  /**
   * Get pending approval by Telegram message ID
   */
  getPendingApprovalByMessageId(messageId: number): PendingApproval | undefined {
    for (const approval of this.pendingApprovals.values()) {
      if (approval.telegramMessageId === messageId) {
        return approval;
      }
    }
    return undefined;
  }
}

/**
 * Create a simple one-shot query (no session management)
 */
export async function runQuery(
  prompt: string,
  options?: Partial<SDKOptions>
): Promise<{ result: string; messages: SDKMessage[] }> {
  const messages: SDKMessage[] = [];
  let result = '';

  const q = query({
    prompt,
    options: {
      allowedTools: SAFE_TOOLS,
      ...options,
    },
  });

  for await (const message of q) {
    messages.push(message);

    if (message.type === 'result' && message.subtype === 'success') {
      result = message.result;
    }
  }

  return { result, messages };
}
