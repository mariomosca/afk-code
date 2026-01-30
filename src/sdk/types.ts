/**
 * SDK Types for AFK-Code Telegram Integration
 */

export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKStatusMessage,
  CanUseTool,
  PermissionResult,
  PermissionBehavior,
  Options as SDKOptions,
  Query,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Tool approval request sent to Telegram
 */
export interface ToolApprovalRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  decisionReason?: string;
}

/**
 * User response to tool approval
 */
export interface ToolApprovalResponse {
  approved: boolean;
  message?: string;
}

/**
 * Session state for Telegram integration
 */
export interface SDKSessionState {
  sessionId: string;
  isActive: boolean;
  cwd: string;
  model: string;
  startedAt: Date;
}

/**
 * Pending approval waiting for user response
 */
export interface PendingApproval {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  telegramMessageId: number;
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
}
