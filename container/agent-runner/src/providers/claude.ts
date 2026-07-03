import fs from 'fs';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }

  // Hard gate: Read on the Obsidian vault. The /task-review skill says
  // "never use direct filesystem access on vault paths" and the obsidian-
  // bridge already strips the verbose ## Transcript section from Meetings/
  // notes. Bypassing the bridge via Read pulls the full file (often 80–
  // 100KB per Granola meeting) and blows out the context window. Verified
  // 2026-05-15 in sess-1778893211049-8bgv1g where a single fresh-session
  // task review hit auto-compaction after 5 such reads. Force the bridge.
  //
  // The denial reason MUST be returned via hookSpecificOutput.permission-
  // DecisionReason — not legacy {decision,stopReason}. Verified by reading
  // the SDK's PreToolUseHookSpecificOutput type in agent-runner's
  // node_modules. The legacy shape returns a generic "denied this tool"
  // to the agent (no reason visible), which is why my first attempt at
  // this gate left Bo confused and bypassing via `Bash: cat`.
  if (toolName === 'Read') {
    const filePath = typeof i.tool_input?.file_path === 'string' ? (i.tool_input.file_path as string) : '';
    if (filePath.startsWith('/workspace/extra/brain/')) {
      const relative = filePath.slice('/workspace/extra/brain/'.length);
      const reason =
        `Read is blocked on Obsidian vault paths (/workspace/extra/brain/). ` +
        `Use the obsidian-bridge instead: ` +
        `curl -s --max-time 15 --noproxy '*' -X POST http://host.docker.internal:27999/run ` +
        `-H 'Content-Type: application/json' ` +
        `-d '{"args":["read","path=${relative}","vault=Brain"]}' | jq -r .stdout ` +
        `— the bridge auto-strips the ## Transcript section from Meetings/ notes so the summary fits in context. ` +
        `Do NOT fall back to \`Bash: cat\` on these paths; that bypasses the bridge's trim and will exhaust context. ` +
        `If you genuinely need a Transcript quote, ask the user first.`;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      } as unknown as ReturnType<HookCallback>;
    }
  }

  // Hard gate: ticket CREATION is restricted to the makebo workspace.
  // Bo has three Linear surfaces — the claude.ai cloud connector
  // (mcp__claude_ai_Linear__*) and mcp__linear-unify__* both point at the
  // Unify COMPANY workspace and literally cannot see makebo; only
  // mcp__linear-makebo__* writes to the right place (team BO). Creating a
  // ticket on a Unify surface is always a mistake (seen twice: J-22, J-23) —
  // instructions alone didn't hold because Bo defaults to the cloud connector.
  // Block Unify-Linear issue *creation* and redirect. Reads and updates
  // (which carry an existing issue id) pass through untouched.
  {
    const lower = toolName.toLowerCase();
    const isUnifyLinear =
      toolName.startsWith('mcp__claude_ai_Linear__') ||
      toolName.startsWith('mcp__linear-unify__');
    const isIssueCreate =
      /create.*issue|issue.*create/.test(lower) ||
      (lower.endsWith('__save_issue') && !i.tool_input?.id);
    if (isUnifyLinear && isIssueCreate) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'This tool writes to the Unify COMPANY workspace (read-only for you). Ticket creation goes to makebo only. Use the `create_ticket` tool (mcp__nanoclaw__create_ticket) — it takes {title, description, priority} and returns a BO-… identifier. "makebo" is resolved: do NOT search Linear or ask what it is. Do NOT retry on any claude_ai_Linear or linear-unify tool.',
        },
      } as unknown as ReturnType<HookCallback>;
    }
  }

  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Heuristically extract corrective user messages from the transcript so they
 * can survive context compaction. Pattern matches Joel's typical correction
 * shapes: "no", "don't", "stop", "never", "always", "you're wrong", or any
 * imperative starting with "use", "send", "don't use", etc. Returns the most
 * recent ones (up to `limit`), oldest-first.
 *
 * Why: Claude Code's auto-compact summarises old turns. Specific corrections
 * ("one table per message, period") get smoothed out. Persisting them to
 * bo-playbook.md before compaction ensures the rule survives — the file is
 * imported into every fresh CLAUDE.md via the bo-self-learning skill.
 */
function extractRecentCorrections(messages: ParsedMessage[], limit = 5): string[] {
  const CORRECTION_RE =
    /\b(no,|don'?t|stop|never|always|you'?re wrong|that'?s wrong|incorrect|don'?t forget|you (have|need) to|you should|you shouldn'?t|use\b|send\b)/i;
  const recent = messages.filter((m) => m.role === 'user').slice(-30);
  const corrective = recent
    .filter((m) => {
      const t = m.content.trim();
      if (t.length < 4 || t.length > 600) return false;
      return CORRECTION_RE.test(t);
    })
    .slice(-limit);
  return corrective.map((m) => m.content.trim().replace(/\s+/g, ' '));
}

/**
 * Append fresh user corrections to bo-playbook.md before context compaction
 * wipes the conversational memory of them. Dedupes against existing content
 * (skip if the exact correction string already appears verbatim). Writes
 * under a dated `## auto-saved-pre-compact-YYYY-MM-DD-HHMM` section so it's
 * easy to audit which entries are auto-captured vs explicit `<memory-write>`.
 */
function persistCorrectionsToPlaybook(corrections: string[]): void {
  if (corrections.length === 0) return;
  const playbookPath = '/workspace/extra/wiki/personal/bo-playbook.md';
  let existing = '';
  try {
    existing = fs.readFileSync(playbookPath, 'utf-8');
  } catch {
    existing = '';
  }
  const fresh = corrections.filter((c) => !existing.includes(c));
  if (fresh.length === 0) {
    log(`PreCompact: ${corrections.length} corrections detected, all already in bo-playbook.md`);
    return;
  }
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const block = [
    '',
    `## auto-saved-pre-compact-${stamp}`,
    'Rule: Joel said these things shortly before context compaction. Re-read carefully — they were said during the immediately previous session and apply going forward.',
    `Why: ${now.toISOString()} — captured automatically by PreCompact hook before the conversation got summarised.`,
    'Corrections (verbatim):',
    ...fresh.map((c) => `- ${c.replace(/\n+/g, ' ')}`),
    '',
  ].join('\n');
  try {
    fs.appendFileSync(playbookPath, block);
    log(`PreCompact: saved ${fresh.length} fresh correction(s) to bo-playbook.md`);
  } catch (err) {
    log(`PreCompact: failed to write bo-playbook.md: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      // Persist recent user corrections to bo-playbook.md BEFORE the compaction
      // wipes them from conversational context. This is the part v1 never had
      // and that caused Bo to forget "one table per message" mid-thread after
      // the SDK auto-compacted.
      try {
        const corrections = extractRecentCorrections(messages);
        persistCorrectionsToPlaybook(corrections);
      } catch (err) {
        log(`PreCompact: correction-persist failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Try to get summary from sessions index
      let summary: string | undefined;
      const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
        } catch {
          /* ignore */
        }
      }

      const name = summary
        ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
        : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);
    // Track latest user prompt so the usage record's `source` field
    // captures the message text Bo was responding to (matches v1's
    // "message: <text>" format).
    let latestPrompt = input.prompt;

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        allowedTools: [
          ...TOOL_ALLOWLIST,
          ...Object.keys(this.mcpServers).map(mcpAllowPattern),
        ],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        settings: { alwaysThinkingEnabled: true } as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'result') {
          const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
          // bo-features: write token usage record per turn. Host-side
          // aggregator (src/plugins/bo-token-usage/index.ts) tails the file
          // and ingests into the central token_usage table.
          try {
            const usage = (message as { usage?: Record<string, number> }).usage;
            const cost = (message as { total_cost_usd?: number }).total_cost_usd;
            const model = (message as { model?: string }).model;
            const sessionId = (message as { session_id?: string }).session_id;
            const numTurns = (message as { num_turns?: number }).num_turns;
            const durationMs = (message as { duration_ms?: number }).duration_ms;
            const durationApiMs = (message as { duration_api_ms?: number }).duration_api_ms;
            if (usage) {
              // Distill the latest prompt into a one-line job label for the
              // dashboard. The full prompt is preserved separately if needed.
              const source = extractJobLabel(latestPrompt);
              const record = {
                ts: new Date().toISOString(),
                sdk_session_id: sessionId,
                model,
                num_turns: numTurns ?? 0,
                input_tokens: usage.input_tokens ?? 0,
                output_tokens: usage.output_tokens ?? 0,
                cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
                cache_read_tokens: usage.cache_read_input_tokens ?? 0,
                total_cost_usd: cost ?? 0,
                duration_ms: durationMs ?? 0,
                duration_api_ms: durationApiMs ?? 0,
                source,
              };
              fs.appendFileSync('/workspace/usage.jsonl', JSON.stringify(record) + '\n');
            }
          } catch (err) {
            log(`Failed to write usage record: ${err instanceof Error ? err.message : String(err)}`);
          }
          yield { type: 'result', text };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'result', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => {
        latestPrompt = msg;
        stream.push(msg);
      },
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

/**
 * Distill a prompt into a one-line job label for the dashboard.
 *
 * The agent-runner wraps each inbound message as XML
 * (`<inbound_messages><message>...</message></inbound_messages>`) — strip
 * that. Tasks have a `[Scheduled task]` prefix — preserve as `task:` prefix.
 * Truncate aggressively so the dashboard table stays readable.
 */
function extractJobLabel(prompt: string): string {
  let text = prompt;
  let prefix = 'message';

  // Strip the `<context timezone=".." />` header formatter.ts prepends to every
  // prompt. Without this, prompts that carry only <task>/<webhook>/<system_response>
  // blocks (no <message>) fall through to using the header as the label.
  text = text.replace(/<context\b[^>]*\/>\s*/i, '');

  // Unwrap whichever message-shaped block formatter.ts produced. \b prevents
  // matching <messages> (the multi-message wrapper); the engine keeps scanning
  // and finds the inner <message ...> instead.
  const blockMatch = text.match(/<(message|task|webhook|system_response)\b[^>]*>([\s\S]*?)<\/\1>/);
  if (blockMatch) {
    let inner = blockMatch[2];
    if (blockMatch[1] === 'task') {
      // <task> bodies are "Script output:\n…\nInstructions:\n<prompt>". Skip to
      // the prompt so the label is the work, not the script-output blob.
      const idx = inner.indexOf('Instructions:');
      if (idx !== -1) inner = inner.slice(idx + 'Instructions:'.length);
      prefix = 'task';
    }
    text = inner;
  }

  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';

  // Legacy: some flows used to prefix prompts with literal "[Scheduled task]"
  // text. Strip it if present so the label is just the task description.
  const cleaned = firstLine.replace(/^\[Scheduled task\]\s*:?\s*/i, (m) => {
    prefix = 'task';
    return '';
  });

  return `${prefix}: ${cleaned}`.slice(0, 100);
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
