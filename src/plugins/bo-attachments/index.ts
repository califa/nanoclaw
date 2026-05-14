/**
 * bo-attachments — SCAFFOLD.
 *
 * Inbound transformer that handles image and PDF attachments: downloads to
 * a session-scoped tmp dir, stuffs the paths into messages_in.attachments
 * so the container's agent-loop can include them as native content blocks
 * in the Anthropic SDK call.
 *
 * Status: scaffold. Real implementation needs:
 *   1. A new column `messages_in.attachments TEXT NULL` (JSON: [{path, mime, kind}]).
 *      (Migration bo-003-messages-in-attachments.ts — not yet written.)
 *   2. Adapter-level changes to surface attachments on InboundEvent. The
 *      chat-adapter packages need verification — they may already pass
 *      attachments through in some shape.
 *   3. Container-side agent-loop reads the attachments column and includes
 *      bytes in the Anthropic API call:
 *        content: [
 *          {type:'image', source:{type:'base64', media_type, data}},
 *          {type:'document', source:{type:'base64', media_type:'application/pdf', data}},
 *          {type:'text', text:<message content>}
 *        ]
 *
 * For now: scaffold only. Attachments arrive as opaque file references in
 * adapter-specific shapes; Bo can't introspect them.
 */
import { log } from '../../log.js';

export default async function init(): Promise<void> {
  log.debug('bo-attachments: scaffold loaded — implementation pending');
}
