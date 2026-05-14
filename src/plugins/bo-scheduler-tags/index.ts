/**
 * bo-scheduler-tags — handlers for <retry>, <healed>, <no-fix> tags.
 *
 * The host parses these from outbound messages (see delivery.ts) and
 * dispatches via the scheduler signal registry. Each handler should update
 * the relevant task's retry/healing state and either requeue or pause it.
 *
 * KNOWN GAP (2026-05-13): v2 stores scheduled-task state in per-session
 * `messages_in` rows (process_after + recurrence + series_id), not in a
 * global `scheduled_tasks` table like v1 had. The lookups below will fail
 * silently and the handlers will no-op until adapted to:
 *   1. Resolve the originating message_in row from ctx.taskId or ctx.sessionId
 *   2. Open the right session's inbound.db
 *   3. Update fields there
 *
 * The plugin currently registers itself and logs handler invocations so the
 * end-to-end signal-parsing pipeline (text → parse → dispatch → handler) is
 * exercised. Real state mutation is deferred.
 *
 * The migration `bo-001-scheduled-task-retry` correctly self-skips since
 * the `scheduled_tasks` table doesn't exist in v2.
 */
import { registerSignalHandler } from '../../extension-points.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

const RETRY_DELAYS_MIN = [15, 30]; // first failure → 15min, second → 30min, third → healer
const HEALER_PROMPT_PREFIX = 'You are a self-healing agent. ';

interface ScheduledTaskRow {
  id: string;
  agent_group_id: string;
  prompt: string;
  retry_count: number;
  next_run_at: string;
}

function getTask(taskId: string | null): ScheduledTaskRow | null {
  if (!taskId) return null;
  try {
    return (
      (getDb()
        .prepare(
          'SELECT id, agent_group_id, prompt, COALESCE(retry_count, 0) AS retry_count, next_run_at FROM scheduled_tasks WHERE id = ?',
        )
        .get(taskId) as ScheduledTaskRow | undefined) ?? null
    );
  } catch (err) {
    log.warn('bo-scheduler-tags: scheduled_tasks lookup failed', { taskId, err });
    return null;
  }
}

function updateTask(taskId: string, updates: Record<string, unknown>): void {
  const cols = Object.keys(updates);
  if (cols.length === 0) return;
  const setClause = cols.map((c) => `${c} = @${c}`).join(', ');
  try {
    getDb()
      .prepare(`UPDATE scheduled_tasks SET ${setClause} WHERE id = @id`)
      .run({ ...updates, id: taskId });
  } catch (err) {
    log.warn('bo-scheduler-tags: scheduled_tasks update failed', { taskId, err });
  }
}

export default async function init(): Promise<void> {
  // ── <retry reason="..." /> ────────────────────────────────────────────────
  registerSignalHandler('retry', async (signal, ctx) => {
    const task = getTask(ctx.taskId);
    if (!task) {
      log.info('bo-scheduler-tags <retry> outside task context — ignoring', {
        sessionId: ctx.sessionId,
        reason: signal.attributes.reason,
      });
      return;
    }

    const retryCount = task.retry_count;
    const reason = signal.attributes.reason ?? '(no reason given)';

    if (retryCount >= RETRY_DELAYS_MIN.length) {
      // Third failure — invoke healer instead of plain retry.
      const healerPrompt = `${HEALER_PROMPT_PREFIX}The task "${task.prompt}" has failed ${retryCount + 1} times. Latest reason: ${reason}. Diagnose and fix the root cause, then emit <healed action="..." /> if fixed or <no-fix reason="..." /> if not.`;
      const nextRunAt = new Date(Date.now() + 60_000).toISOString(); // 1 minute
      updateTask(task.id, {
        retry_count: retryCount + 1,
        last_failure_reason: reason,
        prompt: healerPrompt,
        next_run_at: nextRunAt,
      });
      log.info('bo-scheduler-tags: spawning healer', { taskId: task.id, retryCount });
      return;
    }

    const delayMin = RETRY_DELAYS_MIN[retryCount];
    const nextRunAt = new Date(Date.now() + delayMin * 60_000).toISOString();
    updateTask(task.id, {
      retry_count: retryCount + 1,
      last_failure_reason: reason,
      next_run_at: nextRunAt,
    });
    log.info('bo-scheduler-tags: <retry> requeued', {
      taskId: task.id,
      retryCount: retryCount + 1,
      delayMin,
      reason,
    });
  });

  // ── <healed action="..." /> ───────────────────────────────────────────────
  registerSignalHandler('healed', async (signal, ctx) => {
    const task = getTask(ctx.taskId);
    if (!task) return;

    // Reset retry counter and re-fire the original task once.
    // The original prompt was overwritten by the healer prompt — we don't have
    // it anymore. Convention: the healer should restore the original by
    // emitting it inside the <healed> tag body, OR the task should keep a
    // `original_prompt` copy. For now: reset retry, schedule immediate run
    // with whatever's in `prompt`.
    const action = signal.attributes.action ?? signal.body ?? '(no action)';
    updateTask(task.id, {
      retry_count: 0,
      last_failure_reason: null,
      next_run_at: new Date(Date.now() + 5_000).toISOString(), // 5 sec
    });
    log.info('bo-scheduler-tags: <healed> task re-fired', { taskId: task.id, action });
  });

  // ── <no-fix reason="..." /> ───────────────────────────────────────────────
  registerSignalHandler('no-fix', async (signal, ctx) => {
    const task = getTask(ctx.taskId);
    if (!task) return;
    const reason = signal.attributes.reason ?? signal.body ?? '(no reason)';
    updateTask(task.id, {
      paused_reason: reason,
      next_run_at: '9999-12-31T00:00:00Z', // park the task
    });
    log.warn('bo-scheduler-tags: <no-fix> task paused', { taskId: task.id, reason });
    // TODO: DM the owner via the approvals primitive. For now the pause is
    // visible via `ncl scheduled-tasks list` (or `ncl tasks list` depending
    // on resource name).
  });

  log.info('bo-scheduler-tags: handlers registered for retry/healed/no-fix');
}
