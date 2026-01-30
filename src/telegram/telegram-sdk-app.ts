/**
 * Telegram Bot using Claude Agent SDK
 *
 * Features:
 * - Multi-session support
 * - Session resume
 * - Project selection
 * - Tool approval via inline keyboard
 */

import { Bot, Context, InlineKeyboard } from 'grammy';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'os';
import { readdir, stat, readFile } from 'fs/promises';
import { join, basename } from 'path';
import type {
  Query,
  SDKMessage,
  CanUseTool,
  PermissionResult,
} from '../sdk/types.js';
import type { TelegramConfig } from './types.js';

const MAX_MESSAGE_LENGTH = 4000;
const PROJECTS_ROOT = `${homedir()}/Desktop/Projects`;
const CLAUDE_PROJECTS_DIR = `${homedir()}/.claude/projects`;

interface PendingApproval {
  sessionNum: number;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
}

interface ActiveSession {
  num: number;
  query: Query;
  sessionId: string;
  projectName: string;
  projectPath: string;
  startedAt: Date;
  isResumed: boolean;
}

interface SavedSession {
  sessionId: string;
  projectPath: string;
  projectName: string;
  lastModified: Date;
}

/**
 * Find a project directory by name (fuzzy search)
 */
async function findProject(searchTerm: string): Promise<{ path: string; name: string } | null> {
  const searchLower = searchTerm.toLowerCase().replace(/[-_\s]/g, '');

  async function searchDir(dir: string, depth = 0): Promise<{ path: string; name: string } | null> {
    if (depth > 3) return null;

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

        const entryLower = entry.name.toLowerCase().replace(/[-_\s]/g, '');
        const fullPath = join(dir, entry.name);

        if (entryLower === searchLower || entryLower.includes(searchLower)) {
          return { path: fullPath, name: entry.name };
        }

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

        try {
          const hasGit = await stat(join(fullPath, '.git')).then(() => true).catch(() => false);
          const hasPackage = await stat(join(fullPath, 'package.json')).then(() => true).catch(() => false);

          if (hasGit || hasPackage) {
            projects.push(displayName);
          } else {
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
 * List saved sessions that can be resumed
 */
async function listSavedSessions(): Promise<SavedSession[]> {
  const sessions: SavedSession[] = [];

  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;

      const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir.name);

      try {
        const files = await readdir(projectPath);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.includes('compact'));

        for (const jsonlFile of jsonlFiles) {
          const filePath = join(projectPath, jsonlFile);
          const stats = await stat(filePath);

          // Decode project path from directory name
          const decodedPath = '/' + projectDir.name.replace(/-/g, '/').slice(1);
          const projectName = basename(decodedPath);

          sessions.push({
            sessionId: jsonlFile.replace('.jsonl', ''),
            projectPath: decodedPath,
            projectName,
            lastModified: stats.mtime,
          });
        }
      } catch {
        // Ignore errors reading project dir
      }
    }
  } catch {
    // Ignore if directory doesn't exist
  }

  // Sort by last modified, most recent first
  return sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

/**
 * Parse message for project prefix
 */
function parseProjectFromMessage(text: string): { project: string | null; prompt: string } {
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

  // Multi-session state
  const sessions = new Map<number, ActiveSession>();
  const pendingApprovals = new Map<string, PendingApproval>();
  let sessionCounter = 0;
  let currentSessionNum: number | null = null;

  // Default project
  let currentProjectPath: string = process.cwd();
  let currentProjectName: string = 'default';

  const messageQueue: Array<() => Promise<void>> = [];
  let processingQueue = false;

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

  // Tool approval callback factory (creates callback for specific session)
  function createCanUseTool(sessionNum: number): CanUseTool {
    return async (toolName, input, options) => {
      return new Promise((resolve) => {
        const { toolUseID } = options;
        const session = sessions.get(sessionNum);
        const sessionLabel = session ? `[${sessionNum}] ${session.projectName}` : `[${sessionNum}]`;

        const inputPreview = JSON.stringify(input, null, 2).slice(0, 500);

        const keyboard = new InlineKeyboard()
          .text('Allow', `approve:${toolUseID}`)
          .text('Deny', `deny:${toolUseID}`);

        sendMessage(
          `*Tool Request* ${sessionLabel}\n\n` +
            `Tool: \`${toolName}\`\n` +
            `Reason: ${options.decisionReason ?? 'Permission required'}\n\n` +
            `\`\`\`\n${inputPreview}\n\`\`\``,
          { replyMarkup: keyboard }
        ).then(() => {
          const timeout = setTimeout(() => {
            pendingApprovals.delete(toolUseID);
            resolve({ behavior: 'deny', message: 'Approval timeout (60s)' });
            sendMessage(`Tool request timed out. ${sessionLabel}`);
          }, 60000);

          pendingApprovals.set(toolUseID, {
            sessionNum,
            toolUseId: toolUseID,
            toolName,
            input,
            resolve,
            timeout,
          });
        });
      });
    };
  }

  // Handle SDK messages for a specific session
  function createMessageHandler(sessionNum: number) {
    return (message: SDKMessage): void => {
      const session = sessions.get(sessionNum);
      const prefix = sessions.size > 1 ? `[${sessionNum}] ` : '';

      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            if (session) {
              session.sessionId = message.session_id;
            }
            const resumeLabel = session?.isResumed ? ' (resumed)' : '';
            sendMessage(
              `${prefix}Session started${resumeLabel}\n` +
                `Model: \`${message.model}\`\n` +
                `Project: \`${session?.projectName ?? 'unknown'}\``
            );
          } else if (message.subtype === 'status' && message.status === 'compacting') {
            sendMessage(`${prefix}_Compacting conversation..._`);
          }
          break;

        case 'assistant':
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) {
              sendChunkedMessage(block.text, `${prefix}_Claude:_`);
            }
          }
          break;

        case 'result':
          if (message.subtype === 'success') {
            sendMessage(
              `${prefix}Session complete\n` +
                `Duration: ${(message.duration_ms / 1000).toFixed(1)}s\n` +
                `Cost: $${message.total_cost_usd.toFixed(4)}`
            );
          } else {
            sendMessage(`${prefix}Session error: ${(message as any).error ?? 'Unknown error'}`);
          }
          // Remove session
          sessions.delete(sessionNum);
          if (currentSessionNum === sessionNum) {
            // Switch to another session or null
            const remaining = Array.from(sessions.keys());
            currentSessionNum = remaining.length > 0 ? remaining[0] : null;
          }
          break;
      }
    };
  }

  // Start a new SDK session
  async function startSession(
    prompt: string,
    projectPath: string,
    projectName: string,
    resumeSessionId?: string
  ): Promise<number> {
    const sessionNum = ++sessionCounter;

    await sendMessage(
      `[${sessionNum}] Starting session on \`${projectName}\`...\n` +
        `Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`
    );

    const q = query({
      prompt,
      options: {
        cwd: projectPath,
        canUseTool: createCanUseTool(sessionNum),
        allowedTools: ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch'],
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    });

    const session: ActiveSession = {
      num: sessionNum,
      query: q,
      sessionId: resumeSessionId ?? '',
      projectName,
      projectPath,
      startedAt: new Date(),
      isResumed: !!resumeSessionId,
    };

    sessions.set(sessionNum, session);
    currentSessionNum = sessionNum;

    // Process messages
    const handleMessage = createMessageHandler(sessionNum);
    (async () => {
      try {
        for await (const message of q) {
          handleMessage(message);
        }
      } catch (err: any) {
        console.error(`[SDK] Session ${sessionNum} error:`, err);
        await sendMessage(`[${sessionNum}] Session error: ${err.message}`);
        sessions.delete(sessionNum);
        if (currentSessionNum === sessionNum) {
          const remaining = Array.from(sessions.keys());
          currentSessionNum = remaining.length > 0 ? remaining[0] : null;
        }
      }
    })();

    return sessionNum;
  }

  // Handle callback queries (button presses)
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, toolUseId] = data.split(':');

    const approval = pendingApprovals.get(toolUseId);
    if (!approval) {
      await ctx.answerCallbackQuery({ text: 'Request expired or not found' });
      return;
    }

    clearTimeout(approval.timeout);
    pendingApprovals.delete(toolUseId);

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

    if (text.startsWith('/')) {
      await handleCommand(ctx, text);
      return;
    }

    // Parse for project prefix
    const { project, prompt } = parseProjectFromMessage(text);

    let targetPath = currentProjectPath;
    let targetName = currentProjectName;

    if (project) {
      const found = await findProject(project);
      if (found) {
        targetPath = found.path;
        targetName = found.name;
      } else {
        await ctx.reply(`Project "${project}" not found. Use /projects to list available.`);
        return;
      }
    }

    await startSession(prompt, targetPath, targetName);
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
            `*Commands:*\n` +
            `/sessions - List active sessions\n` +
            `/switch <n> - Switch to session n\n` +
            `/stop [n] - Stop session (current or n)\n` +
            `/resume [id] - Resume a saved session\n` +
            `/project <name> - Set default project\n` +
            `/projects - List available projects\n` +
            `/help - Show all commands`,
          { parse_mode: 'Markdown' }
        );
        break;

      case '/sessions': {
        if (sessions.size === 0) {
          await ctx.reply('No active sessions.');
          return;
        }

        const list = Array.from(sessions.values())
          .map((s) => {
            const current = s.num === currentSessionNum ? ' *← current*' : '';
            const elapsed = Math.floor((Date.now() - s.startedAt.getTime()) / 1000);
            const resumed = s.isResumed ? ' (resumed)' : '';
            return `[${s.num}] \`${s.projectName}\`${resumed} - ${elapsed}s${current}`;
          })
          .join('\n');

        await ctx.reply(`*Active Sessions:*\n\n${list}`, { parse_mode: 'Markdown' });
        break;
      }

      case '/switch': {
        const num = parseInt(args[0]);
        if (isNaN(num) || !sessions.has(num)) {
          await ctx.reply(
            `Invalid session number. Active: ${Array.from(sessions.keys()).join(', ') || 'none'}`
          );
          return;
        }
        currentSessionNum = num;
        const session = sessions.get(num)!;
        await ctx.reply(`Switched to session [${num}] \`${session.projectName}\``, {
          parse_mode: 'Markdown',
        });
        break;
      }

      case '/stop': {
        const num = args[0] ? parseInt(args[0]) : currentSessionNum;
        if (num === null || !sessions.has(num)) {
          await ctx.reply('No session to stop.');
          return;
        }
        const session = sessions.get(num)!;
        session.query.close();
        sessions.delete(num);
        if (currentSessionNum === num) {
          const remaining = Array.from(sessions.keys());
          currentSessionNum = remaining.length > 0 ? remaining[0] : null;
        }
        await ctx.reply(`Session [${num}] \`${session.projectName}\` stopped.`, {
          parse_mode: 'Markdown',
        });
        break;
      }

      case '/resume': {
        const sessionIdArg = args[0];

        if (!sessionIdArg) {
          // List available sessions to resume
          const saved = await listSavedSessions();
          if (saved.length === 0) {
            await ctx.reply('No saved sessions found.');
            return;
          }

          const list = saved.slice(0, 10).map((s) => {
            const ago = Math.floor((Date.now() - s.lastModified.getTime()) / 60000);
            const agoStr = ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`;
            return `\`${s.sessionId.slice(0, 8)}\` - ${s.projectName} (${agoStr})`;
          }).join('\n');

          await ctx.reply(
            `*Recent Sessions:*\n\n${list}\n\n` +
              `Use \`/resume <id> [prompt]\` to resume.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // Find the session
        const saved = await listSavedSessions();
        const match = saved.find((s) => s.sessionId.startsWith(sessionIdArg));

        if (!match) {
          await ctx.reply(`Session "${sessionIdArg}" not found.`);
          return;
        }

        const prompt = args.slice(1).join(' ') || 'Continue where we left off.';
        await startSession(prompt, match.projectPath, match.projectName, match.sessionId);
        break;
      }

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

      case '/status': {
        if (sessions.size === 0) {
          await ctx.reply(
            `No active sessions.\n` +
              `Current project: \`${currentProjectName}\``,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        const session = currentSessionNum ? sessions.get(currentSessionNum) : null;
        if (session) {
          const elapsed = Date.now() - session.startedAt.getTime();
          const pendingCount = Array.from(pendingApprovals.values())
            .filter((a) => a.sessionNum === session.num).length;
          await ctx.reply(
            `*Current Session [${session.num}]*\n` +
              `ID: \`${session.sessionId.slice(0, 8)}...\`\n` +
              `Project: \`${session.projectName}\`\n` +
              `Duration: ${(elapsed / 1000).toFixed(0)}s\n` +
              `Pending approvals: ${pendingCount}\n` +
              `Total sessions: ${sessions.size}`,
            { parse_mode: 'Markdown' }
          );
        }
        break;
      }

      case '/interrupt': {
        const num = args[0] ? parseInt(args[0]) : currentSessionNum;
        if (num === null || !sessions.has(num)) {
          await ctx.reply('No session to interrupt.');
          return;
        }
        const session = sessions.get(num)!;
        await session.query.interrupt();
        await ctx.reply(`Interrupt sent to [${num}] \`${session.projectName}\``, {
          parse_mode: 'Markdown',
        });
        break;
      }

      case '/help':
        await ctx.reply(
          `*Commands:*\n\n` +
            `*Sessions:*\n` +
            `/sessions - List active sessions\n` +
            `/switch <n> - Switch to session n\n` +
            `/stop [n] - Stop session\n` +
            `/interrupt [n] - Interrupt session\n` +
            `/status - Current session info\n` +
            `/resume [id] - Resume saved session\n\n` +
            `*Projects:*\n` +
            `/project <name> - Set default project\n` +
            `/projects - List available projects\n\n` +
            `*Syntax:*\n` +
            `\`su ProjectName: prompt\`\n` +
            `\`@ProjectName prompt\`\n\n` +
            `_Multiple sessions run in parallel._`,
          { parse_mode: 'Markdown' }
        );
        break;
    }
  }

  return { bot };
}
