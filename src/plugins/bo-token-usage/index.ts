/**
 * bo-token-usage — SCAFFOLD.
 *
 * Logs Anthropic SDK token usage per session into `data/v2.db.token_usage`.
 * Surfaces via the dashboard pusher and a new `ncl usage` resource.
 *
 * Status: not yet implemented. The hook point is in the agent-runner
 * (container/agent-runner/src/agent-loop.ts), not the host — this plugin file
 * exists as a placeholder so the install pipeline is complete. Real logging
 * has to happen container-side, then the container writes to a shared DB
 * the host can read.
 *
 * Implementation sketch:
 *   1. In container/agent-runner, wrap the SDK call:
 *        const result = await sdk.messages.create(...);
 *        writeTokenUsage({
 *          session_id, agent_group_id, model,
 *          input_tokens: result.usage.input_tokens,
 *          output_tokens: result.usage.output_tokens,
 *          cache_creation_tokens: result.usage.cache_creation_input_tokens,
 *          cache_read_tokens: result.usage.cache_read_input_tokens,
 *          ts: new Date().toISOString(),
 *        });
 *   2. writeTokenUsage writes to a DB shared via mount — either:
 *      (a) Each session has a usage.db (single writer, easy)
 *      (b) Or write to a per-session record in outbound.db, host aggregates
 *   3. Host's bo-token-usage plugin (this file) registers a periodic
 *      aggregator that pulls per-session usage into v2.db.token_usage.
 *   4. Add `ncl usage --period 24h|7d|30d` resource.
 *   5. Add a "token_usage" block to the dashboard pusher's snapshot payload.
 *
 * Migration: see ../../../migrations/bo-002-token-usage.ts
 */
import { log } from '../../log.js';

export default async function init(): Promise<void> {
  log.debug('bo-token-usage: scaffold loaded — implementation deferred to container-side hook');
}
