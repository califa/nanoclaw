import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getRecentTaskRunLogs,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterFailure,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  logUsage?: (entry: import('./db.js').TokenUsageEntry) => void;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          // Log token usage if available
          // Log token usage if available
          if (streamedOutput.usage) {
            deps.logUsage?.({
              group_folder: task.group_folder,
              chat_jid: task.chat_jid,
              source: `task:${task.id}`,
              ...streamedOutput.usage,
            });
          }
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;
  const retrySignal = parseRetrySignal(result);
  const failed = !!error || !!retrySignal;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error: error ?? retrySignal ?? null,
  });

  const nextRun = computeNextRun(task);

  if (failed) {
    const newFailures = (task.consecutive_failures ?? 0) + 1;
    const failureReason = error
      ? `Error: ${error.slice(0, 150)}`
      : `Retry requested: ${retrySignal}`;
    const resultSummary = `[Failure ${newFailures}] ${failureReason}`;

    if (newFailures >= MAX_RETRIES) {
      if (!task.heal_attempted) {
        // Run the healer before giving up
        logger.info({ taskId: task.id, failures: newFailures }, 'Task hit retry limit, running healer');
        updateTaskAfterFailure(task.id, nextRun, resultSummary, null, newFailures, true);

        const healerOutput = await runHealerTask(task, deps);
        const healed = parseHealedSignal(healerOutput);
        const noFix = parseNoFixSignal(healerOutput);

        if (healed) {
          // Healer fixed it — schedule a retry soon and reset failure count
          const retryAt = new Date(Date.now() + HEAL_RETRY_DELAY_MS).toISOString();
          logger.info({ taskId: task.id, fix: healed }, 'Healer succeeded, scheduling retry');
          updateTaskAfterFailure(task.id, nextRun, `[Healed] ${healed.slice(0, 200)}`, retryAt, 0);
        } else {
          // Healer couldn't fix it — notify user with diagnosis
          const diagnosis = noFix ?? healerOutput?.slice(0, 300) ?? 'No diagnosis available';
          logger.warn({ taskId: task.id }, 'Healer could not fix task, notifying user');
          await deps.sendMessage(
            task.chat_jid,
            `Task *${task.id}* failed ${newFailures} times. I tried to diagnose and fix it automatically but couldn't.\n\n*Diagnosis:* ${diagnosis}`,
          );
          updateTaskAfterRun(task.id, nextRun, `[Unresolved] ${diagnosis.slice(0, 200)}`);
        }
      } else {
        // Healer already ran and still failing — give up until next scheduled window
        logger.warn({ taskId: task.id, failures: newFailures }, 'Task still failing after heal attempt, notifying user');
        await deps.sendMessage(
          task.chat_jid,
          `Task *${task.id}* is still failing after an automatic fix attempt. Skipping until the next scheduled run.\n\nLast error: ${failureReason}`,
        );
        updateTaskAfterRun(task.id, nextRun, `[Gave up] ${resultSummary}`);
      }
    } else {
      const delayMs = RETRY_DELAYS_MS[newFailures - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      logger.info({ taskId: task.id, failures: newFailures, retryAt }, 'Task failed, scheduling retry');
      updateTaskAfterFailure(task.id, nextRun, resultSummary, retryAt, newFailures);
    }
  } else {
    const resultSummary = result ? result.slice(0, 200) : 'Completed';
    updateTaskAfterRun(task.id, nextRun, resultSummary);
  }
}

const MAX_RETRIES = 3; // failures before healer runs
const RETRY_DELAYS_MS = [15 * 60 * 1000, 30 * 60 * 1000]; // 15 min, 30 min before heal attempt
const HEAL_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 min after a successful heal

/** Parse a <retry>reason</retry> signal from agent output. Returns reason or null. */
function parseRetrySignal(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/<retry>([\s\S]*?)<\/retry>/);
  return match ? match[1].trim() : null;
}

/** Parse a <healed>description</healed> signal. Returns description or null. */
function parseHealedSignal(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/<healed>([\s\S]*?)<\/healed>/);
  return match ? match[1].trim() : null;
}

/** Parse a <no-fix>diagnosis</no-fix> signal. Returns diagnosis or null. */
function parseNoFixSignal(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/<no-fix>([\s\S]*?)<\/no-fix>/);
  return match ? match[1].trim() : null;
}

/**
 * Run a healer agent for a repeatedly-failing task.
 * The healer gets the error history and attempts to diagnose and fix the root cause.
 * Returns the healer's output text, or null if the healer itself crashed.
 */
async function runHealerTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<string | null> {
  const logs = getRecentTaskRunLogs(task.id, 5);
  const errorSummary = logs
    .map(
      (l, i) =>
        `Run ${i + 1} (${l.run_at}): status=${l.status}` +
        (l.error ? `, error=${l.error.slice(0, 300)}` : '') +
        (l.result ? `, result=${l.result.slice(0, 200)}` : ''),
    )
    .join('\n');

  const healPrompt = `You are a self-healing agent. The scheduled task "${task.id}" has failed ${task.consecutive_failures ?? 0} times in a row.

## Failing task prompt (summarised)
${task.prompt.slice(0, 800)}${task.prompt.length > 800 ? '\n...(truncated)' : ''}

## Recent failure history
${errorSummary}

## Your job
1. Diagnose the root cause of the failures from the error history above.
2. Investigate the system to confirm your diagnosis (check logs, test commands, inspect config, etc.).
3. Attempt to fix the underlying issue.
4. Test that your fix works.

When done, emit ONE of:
- <healed>Brief description of what was broken and what you fixed</healed>
  Use this if you successfully fixed the root cause.
- <no-fix>Brief diagnosis of what is broken and why you couldn't fix it automatically</no-fix>
  Use this if the issue requires manual intervention.

Do not attempt to re-run the original task yourself. Just fix the environment so the next retry succeeds.`;

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find((g) => g.folder === task.group_folder);
  if (!group) return null;

  let healerResult: string | null = null;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: healPrompt,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain: group.isMain === true,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          healerResult = streamedOutput.result;
        }
      },
    );
    if (output.result) healerResult = output.result;
  } catch (err) {
    logger.error({ taskId: task.id, err }, 'Healer container failed');
  }

  return healerResult;
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
