/**
 * Telegram Bot using Claude Agent SDK
 *
 * Replaces PTY-based approach with direct SDK integration.
 */

import { Bot, Context, InlineKeyboard } from 'grammy';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'os';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import type {
  Query,
  SDKMessage,
  CanUseTool,
  PermissionResult,
} from '../sdk/types.js';
import type { TelegramConfig } from './types.js';

const MAX_MESSAGE_LENGTH = 4000;
const PROJECTS_ROOT = `${homedir()}/Desktop/Projects`;

interface PendingApproval {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
}

interface ActiveSession {
  query: Query;
  sessionId: string;
  startedAt: Date;
  pendingApprovals: Map<string, PendingApproval>;
}

/**
 * Find a project directory by name (fuzzy search)
 */
async function findProject(searchTerm: string): Promise<{ path: string; name: string } | null> {
  const searchLower = searchTerm.toLowerCase().replace(/[-_\s]/g, '');

  async function searchDir(dir: string, depth = 0): Promise<{ path: string; name: string } | null> {
    if (depth > 3) return null; // Max depth

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const entryLower = entry.name.toLowerCase().replace(/[-_\s]/g, '');
        const fullPath = join(dir, entry.name);

        // Exact or partial match
        if (entryLower === searchLower || entryLower.includes(searchLower)) {
          return { path: fullPath, name: entry.name };
        }

        // Recurse into subdirectories
        const found = await searchDir(fullPath, depth + 1);
        if (found) return found;
      }
    } catch {
      // Ignore permission errors
    }

    return null;
  }

  return searchDir(PROJECTS_ROOT);
}

/**
 * List available projects
 */
async function listProjects(): Promise<string[]> {
  const projects: string[] = [];

  async function collectProjects(dir: string, prefix = '', depth = 0): Promise<void> {
    if (depth > 2) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const fullPath = join(dir, entry.name);
        const displayName = prefix ? `${prefix}/${entry.name}` : entry.name;

        // Check if it looks like a project (has package.json, .git, etc.)
        try {
          const hasGit = await stat(join(fullPath, '.git')).then(() => true).catch(() => false);
          const hasPackage = await stat(join(fullPath, 'package.json')).then(() => true).catch(() => false);

          if (hasGit || hasPackage) {
            projects.push(displayName);
          } else {
            // Recurse into category folders
            await collectProjects(fullPath, displayName, depth + 1);
          }
        } catch {
          await collectProjects(fullPath, displayName, depth + 1);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  await collectProjects(PROJECTS_ROOT);
  return projects.sort();
}

/**
 * Parse message for project prefix
 * Formats: "su ProjectName: prompt" or "@ProjectName prompt" or "in ProjectName: prompt"
 */
function parseProjectFromMessage(text: string): { project: string | null; prompt: string } {
  // Pattern: "su/in/on ProjectName: prompt" or "@ProjectName prompt"
  const patterns = [
    /^(?:su|in|on)\s+([^\s:]+):\s*(.+)$/is,
    /^@([^\s]+)\s+(.+)$/is,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return { project: match[1], prompt: match[2] };
    }
  }

  return { project: null, prompt: text };
}

export function createTelegramSDKApp(config: TelegramConfig) {
  const bot = new Bot(config.botToken);

  let activeSession: ActiveSession | null = null;
  let currentProjectPath: string = process.cwd();
  let currentProjectName: string = 'default';
  const messageQueue: Array<() => Promise<void>> = [];
  let processingQueue = false;

  // Message queue for rate limiting
  async function processQueue() {
    if (processingQueue) return;
    processingQueue = true;

    while (messageQueue.length > 0) {
      const fn = messageQueue.shift();
      if (fn) {
        try {
          await fn();
        } catch (err) {
          console.error('[Telegram] Error sending message:', err);
        }
        if (messageQueue.length > 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    processingQueue = false;
  }

  async function sendMessage(
    text: string,
    options?: {
      parseMode?: 'Markdown' | 'HTML';
      disableNotification?: boolean;
      replyMarkup?: InlineKeyboard;
    }
  ): Promise<number> {
    return new Promise((resolve) => {
      messageQueue.push(async () => {
        try {
          const msg = await bot.api.sendMessage(config.chatId, text, {
            parse_mode: options?.parseMode ?? 'Markdown',
            disable_notification: options?.disableNotification,
            reply_markup: options?.replyMarkup,
          });
          resolve(msg.message_id);
        } catch (err: any) {
          // If markdown fails, try without formatting
          if (options?.parseMode && err.message?.includes('parse')) {
            const msg = await bot.api.sendMessage(config.chatId, text, {
              disable_notification: options?.disableNotification,
              reply_markup: options?.replyMarkup,
            });
            resolve(msg.message_id);
          } else {
            console.error('[Telegram] Send error:', err);
            resolve(0);
          }
        }
      });
      processQueue();
    });
  }

  function chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    return chunks;
  }

  async function sendChunkedMessage(text: string, prefix?: string): Promise<void> {
    const chunks = chunkText(text, MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = prefix && i === 0 ? `${prefix} ${chunks[i]}` : chunks[i];
      await sendMessage(chunk);
    }
  }

  // Tool approval callback
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    return new Promise((resolve) => {
      const { toolUseID } = options;

      // Format tool input for display
      const inputPreview = JSON.stringify(input, null, 2).slice(0, 500);

      const keyboard = new InlineKeyboard()
        .text('Allow', `approve:${toolUseID}`)
        .text('Deny', `deny:${toolUseID}`);

      // Send approval request
      sendMessage(
        `*Tool Request*\n\n` +
          `Tool: \`${toolName}\`\n` +
          `Reason: ${options.decisionReason ?? 'Permission required'}\n\n` +
          `\`\`\`\n${inputPreview}\n\`\`\``,
        { replyMarkup: keyboard }
      ).then((messageId) => {
        // Store pending approval
        const timeout = setTimeout(() => {
          activeSession?.pendingApprovals.delete(toolUseID);
          resolve({ behavior: 'deny', message: 'Approval timeout (60s)' });
          sendMessage('Tool request timed out.');
        }, 60000);

        activeSession?.pendingApprovals.set(toolUseID, {
          toolUseId: toolUseID,
          toolName,
          input,
          resolve,
          timeout,
        });
      });
    });
  };

  // Handle SDK messages
  function handleSDKMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          sendMessage(
            `Session started\n` +
              `Model: \`${message.model}\`\n` +
              `Directory: \`${message.cwd}\``
          );
        } else if (message.subtype === 'status' && message.status === 'compacting') {
          sendMessage('_Compacting conversation..._');
        }
        break;

      case 'assistant':
        // Extract text from assistant message
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            sendChunkedMessage(block.text, '_Claude:_');
          }
        }
        break;

      case 'result':
        if (message.subtype === 'success') {
          sendMessage(
            `Session complete\n` +
              `Duration: ${(message.duration_ms / 1000).toFixed(1)}s\n` +
              `Cost: $${message.total_cost_usd.toFixed(4)}`
          );
        } else {
          sendMessage(`Session error: ${(message as any).error ?? 'Unknown error'}`);
        }
        activeSession = null;
        break;
    }
  }

  // Start a new SDK session
  async function startSession(prompt: string, cwd: string): Promise<void> {
    if (activeSession) {
      await sendMessage('Session already active. Use /stop first.');
      return;
    }

    await sendMessage(`Starting session...\nPrompt: ${prompt.slice(0, 100)}...`);

    const q = query({
      prompt,
      options: {
        cwd,
        canUseTool,
        // Safe tools are auto-allowed
        allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch'],
      },
    });

    activeSession = {
      query: q,
      sessionId: '',
      startedAt: new Date(),
      pendingApprovals: new Map(),
    };

    // Process messages
    (async () => {
      try {
        for await (const message of q) {
          // Capture session ID
          if (message.type === 'system' && message.subtype === 'init') {
            activeSession!.sessionId = message.session_id;
          }
          handleSDKMessage(message);
        }
      } catch (err: any) {
        console.error('[SDK] Error:', err);
        await sendMessage(`Session error: ${err.message}`);
        activeSession = null;
      }
    })();
  }

  // Handle callback queries (button presses)
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, toolUseId] = data.split(':');

    const approval = activeSession?.pendingApprovals.get(toolUseId);
    if (!approval) {
      await ctx.answerCallbackQuery({ text: 'Request expired or not found' });
      return;
    }

    clearTimeout(approval.timeout);
    activeSession?.pendingApprovals.delete(toolUseId);

    if (action === 'approve') {
      approval.resolve({ behavior: 'allow', updatedInput: approval.input });
      await ctx.answerCallbackQuery({ text: 'Approved' });
      await ctx.editMessageText(
        ctx.callbackQuery.message?.text + '\n\n_Approved_',
        { parse_mode: 'Markdown' }
      );
    } else {
      approval.resolve({ behavior: 'deny', message: 'User denied' });
      await ctx.answerCallbackQuery({ text: 'Denied' });
      await ctx.editMessageText(
        ctx.callbackQuery.message?.text + '\n\n_Denied_',
        { parse_mode: 'Markdown' }
      );
    }
  });

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    if (ctx.chat.id.toString() !== config.chatId) return;

    const text = ctx.message.text;

    // Commands
    if (text.startsWith('/')) {
      await handleCommand(ctx, text);
      return;
    }

    // If no session, start one with the message as prompt
    if (!activeSession) {
      // Parse for project prefix
      const { project, prompt } = parseProjectFromMessage(text);

      let targetPath = currentProjectPath;
      let targetName = currentProjectName;

      if (project) {
        const found = await findProject(project);
        if (found) {
          targetPath = found.path;
          targetName = found.name;
          await sendMessage(`Project: \`${found.name}\``);
        } else {
          await ctx.reply(`Project "${project}" not found. Use /projects to list available.`);
          return;
        }
      }

      await startSession(prompt, targetPath);
      return;
    }

    // TODO: Send follow-up message to active session
    // This requires streamInput which is more complex
    await ctx.reply('Follow-up messages not yet implemented. Use /stop to end session.');
  });

  async function handleCommand(ctx: Context, text: string) {
    const [command, ...args] = text.split(' ');

    switch (command.toLowerCase()) {
      case '/start':
        await ctx.reply(
          `*AFK Code SDK Bot*\n\n` +
            `Send any message to start a Claude session.\n\n` +
            `*Project syntax:*\n` +
            `\`su ProjectName: your prompt\`\n` +
            `\`@ProjectName your prompt\`\n\n` +
            `Commands:\n` +
            `/project <name> - Set current project\n` +
            `/projects - List available projects\n` +
            `/stop - Stop current session\n` +
            `/status - Show session status\n` +
            `/help - Show this message`,
          { parse_mode: 'Markdown' }
        );
        break;

      case '/project': {
        const projectName = args.join(' ').trim();
        if (!projectName) {
          await ctx.reply(
            `*Current project:* \`${currentProjectName}\`\n` +
              `Path: \`${currentProjectPath}\`\n\n` +
              `Use \`/project <name>\` to change.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const found = await findProject(projectName);
        if (found) {
          currentProjectPath = found.path;
          currentProjectName = found.name;
          await ctx.reply(
            `Project set to \`${found.name}\`\n` +
              `Path: \`${found.path}\``,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.reply(
            `Project "${projectName}" not found.\n` +
              `Use /projects to list available.`
          );
        }
        break;
      }

      case '/projects': {
        const projects = await listProjects();
        if (projects.length === 0) {
          await ctx.reply('No projects found.');
          return;
        }

        const list = projects.slice(0, 30).map((p) => `• \`${p}\``).join('\n');
        const more = projects.length > 30 ? `\n\n_...and ${projects.length - 30} more_` : '';
        await ctx.reply(
          `*Available Projects:*\n\n${list}${more}`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case '/stop':
        if (activeSession) {
          activeSession.query.close();
          activeSession = null;
          await ctx.reply('Session stopped.');
        } else {
          await ctx.reply('No active session.');
        }
        break;

      case '/status':
        if (activeSession) {
          const elapsed = Date.now() - activeSession.startedAt.getTime();
          await ctx.reply(
            `*Active Session*\n` +
              `ID: \`${activeSession.sessionId}\`\n` +
              `Project: \`${currentProjectName}\`\n` +
              `Duration: ${(elapsed / 1000).toFixed(0)}s\n` +
              `Pending approvals: ${activeSession.pendingApprovals.size}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.reply(
            `No active session.\n` +
              `Current project: \`${currentProjectName}\``,
            { parse_mode: 'Markdown' }
          );
        }
        break;

      case '/interrupt':
        if (activeSession) {
          await activeSession.query.interrupt();
          await ctx.reply('Interrupt sent.');
        } else {
          await ctx.reply('No active session.');
        }
        break;

      case '/help':
        await ctx.reply(
          `*Commands:*\n\n` +
            `/project <name> - Set current project\n` +
            `/projects - List available projects\n` +
            `/stop - Stop current session\n` +
            `/status - Show session status\n` +
            `/interrupt - Interrupt current task\n` +
            `/help - Show this message\n\n` +
            `*Project syntax:*\n` +
            `\`su ProjectName: prompt\`\n` +
            `\`@ProjectName prompt\`\n\n` +
            `_Or set project with /project, then send prompts._`,
          { parse_mode: 'Markdown' }
        );
        break;
    }
  }

  return { bot };
}
