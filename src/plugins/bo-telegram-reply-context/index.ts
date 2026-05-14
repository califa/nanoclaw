/**
 * bo-telegram-reply-context — SCAFFOLD.
 *
 * Pulls reply_to_message metadata from raw Telegram updates and prepends a
 * <reply_context>...</reply_context> block to the inbound message content,
 * so Bo has thread context when Joel replies to a specific earlier message.
 *
 * Status: scaffold. Real implementation needs:
 *   1. The @chat-adapter/telegram package needs to surface reply_to_message
 *      in the InboundEvent. Check if it already does (look at the
 *      onInbound payload shape under event.message.metadata or similar).
 *   2. If exposed: read it, format as <reply_context from="@alice"
 *      original="..." />, prepend to content. Done.
 *   3. If not exposed: would need to patch the adapter — likely upstream
 *      contribution to chat-adapter.
 *
 * Implementation should live as an inbound transformer registered only
 * when event.channelType === 'telegram'.
 */
import { log } from '../../log.js';

export default async function init(): Promise<void> {
  log.debug('bo-telegram-reply-context: scaffold loaded — needs adapter introspection');
}
