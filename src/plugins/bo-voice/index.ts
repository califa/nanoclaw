/**
 * bo-voice — inbound transformer that transcribes audio attachments via
 * OpenAI Whisper before they reach the router.
 *
 * Wire:
 *   - Adapter delivers an InboundEvent with `message.attachments` containing
 *     audio bytes (or a path to a local file).
 *   - We detect audio types, POST to Whisper, get text.
 *   - We mutate event.message.content to prepend `[Voice transcribed: <text>]`.
 *
 * Credentials: WHISPER_API_KEY from .env (paid OpenAI usage). If unset, the
 * plugin logs and passes the event through unchanged.
 *
 * The Anthropic SDK could also handle audio natively in some models, but
 * dedicated transcription is cheaper and works for any downstream model.
 */
import fs from 'fs';
import path from 'path';
import { registerInboundTransformer } from '../../extension-points.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const AUDIO_MIME_PREFIXES = ['audio/', 'video/ogg'];

interface AttachmentLike {
  mime?: string;
  path?: string;
  data?: Buffer | string;
}

function isAudio(att: AttachmentLike): boolean {
  if (!att.mime) return false;
  return AUDIO_MIME_PREFIXES.some((p) => att.mime!.startsWith(p));
}

async function transcribe(audioBuf: Buffer, mime: string, apiKey: string): Promise<string | null> {
  const fd = new FormData();
  const blob = new Blob([audioBuf], { type: mime });
  fd.append('file', blob, `voice.${mime.split('/')[1] ?? 'ogg'}`);
  fd.append('model', 'whisper-1');
  fd.append('response_format', 'text');

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!res.ok) {
      const txt = await res.text();
      log.warn('bo-voice: Whisper API rejected request', { status: res.status, body: txt.slice(0, 200) });
      return null;
    }
    const text = (await res.text()).trim();
    return text || null;
  } catch (err) {
    log.warn('bo-voice: Whisper API request threw', { err });
    return null;
  }
}

export default async function init(): Promise<void> {
  const env = readEnvFile(['WHISPER_API_KEY']);
  if (!env.WHISPER_API_KEY) {
    log.warn('bo-voice: WHISPER_API_KEY not set in .env — voice transcription disabled');
    return;
  }
  const apiKey = env.WHISPER_API_KEY;

  registerInboundTransformer(async (event) => {
    // The InboundEvent shape depends on the adapter. We probe for common
    // attachment shapes; if none match, pass through.
    const msg = event.message as { content: string; attachments?: AttachmentLike[] };
    const attachments = msg.attachments ?? [];
    const audioAtts = attachments.filter(isAudio);
    if (audioAtts.length === 0) return event;

    const transcripts: string[] = [];
    for (const att of audioAtts) {
      let buf: Buffer | null = null;
      if (att.path && fs.existsSync(att.path)) {
        buf = fs.readFileSync(att.path);
      } else if (att.data) {
        buf = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data, 'base64');
      }
      if (!buf) continue;
      const text = await transcribe(buf, att.mime ?? 'audio/ogg', apiKey);
      if (text) {
        transcripts.push(text);
        log.info('bo-voice: transcribed', { chars: text.length, mime: att.mime });
      }
    }

    if (transcripts.length === 0) return event;

    const prefix = transcripts.map((t) => `[Voice transcribed: ${t}]`).join('\n');
    const original = typeof msg.content === 'string' ? msg.content : '';
    const newContent = original ? `${prefix}\n\n${original}` : prefix;

    return {
      ...event,
      message: { ...msg, content: newContent } as typeof event.message,
    };
  });

  log.info('bo-voice: inbound transformer registered (OpenAI Whisper)');
}
