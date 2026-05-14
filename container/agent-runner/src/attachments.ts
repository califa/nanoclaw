/**
 * Materialize inbound message attachments to disk so the agent's Read tool
 * can see them.
 *
 * The chat-sdk-bridge already downloads attachment bytes server-side and
 * puts them as base64 strings into the message content's `attachments[]`
 * array (each: { type, name, mimeType, size, data }). This module decodes
 * those base64 strings into actual files under /workspace/attachments/
 * and mutates the in-memory message to add `localPath` so the formatter's
 * existing `[image: foo.jpg — saved to /workspace/attachments/foo.jpg]`
 * placeholder emits the right path.
 *
 * Claude Code SDK's Read tool natively renders images and PDFs, so Bo
 * sees the file when he reads it — no special content blocks needed.
 */
import fs from 'fs';
import path from 'path';

const ATTACHMENTS_DIR = '/workspace/attachments';

function log(msg: string): void {
  console.error(`[attachments] ${msg}`);
}

function safeFilename(name: string, idx: number, ext: string): string {
  const stem = (name || `att-${idx}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 80);
  // Add a numeric suffix to avoid collisions when the same name comes through twice.
  return `${Date.now()}-${idx}-${stem}${ext}`;
}

function extFromMime(mimeType: string | undefined, fallback: string): string {
  if (!mimeType) return fallback;
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'application/pdf': '.pdf',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
  };
  return map[mimeType] ?? fallback;
}

interface AttachmentLike {
  name?: string;
  filename?: string;
  type?: string;
  mimeType?: string;
  data?: string;
  localPath?: string;
}

/**
 * Materialize attachments for one message's parsed content object. Mutates
 * the input — appends localPath to each attachment that had base64 data.
 */
export function materializeAttachments(content: { attachments?: AttachmentLike[] } | null | undefined): void {
  if (!content || !Array.isArray(content.attachments)) return;

  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

  for (let i = 0; i < content.attachments.length; i++) {
    const att = content.attachments[i];
    if (att.localPath || !att.data) continue;

    try {
      const existing = att.name || att.filename || '';
      const hasExt = /\.[a-zA-Z0-9]+$/.test(existing);
      const ext = hasExt ? '' : extFromMime(att.mimeType, '.bin');
      const filename = safeFilename(existing, i, ext);
      const filePath = path.join(ATTACHMENTS_DIR, filename);

      const buf = Buffer.from(att.data, 'base64');
      fs.writeFileSync(filePath, buf);
      // Store the path RELATIVE to /workspace/ so formatAttachments emits it correctly.
      att.localPath = `attachments/${filename}`;
      // Free the base64 string — it's heavy and we don't need it after disk write.
      delete att.data;
      log(`materialized ${att.mimeType || att.type} → ${filePath} (${buf.length} bytes)`);
    } catch (err) {
      log(`failed to materialize attachment ${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
