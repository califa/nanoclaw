/**
 * bo-voice — inbound transformer that transcribes audio attachments using
 * local whisper.cpp (same approach as v1 fork — no API key required).
 *
 * Pipeline:
 *   1. Channel adapter delivers InboundEvent with message.attachments[]
 *      containing audio (path or bytes).
 *   2. ffmpeg converts ogg/opus/m4a to 16kHz mono WAV.
 *   3. whisper-cli transcribes the WAV.
 *   4. We prepend [Voice transcribed: <text>] to message.content.
 *
 * Defaults (override via .env):
 *   WHISPER_BIN=/opt/homebrew/bin/whisper-cli
 *   WHISPER_MODEL=<projectRoot>/data/models/ggml-base.bin
 *   FFMPEG_BIN=/opt/homebrew/bin/ffmpeg
 *
 * Fallback: if whisper-cli isn't installed AND WHISPER_API_KEY is set, falls
 * back to OpenAI Whisper API. If neither is available, passes events through
 * unchanged with a one-time warning at boot.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { registerInboundTransformer } from '../../extension-points.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const execFileAsync = promisify(execFile);

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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function transcribeLocal(
  audioBuf: Buffer,
  whisperBin: string,
  whisperModel: string,
  ffmpegBin: string,
): Promise<string | null> {
  const id = `bo-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpInput = path.join(os.tmpdir(), `${id}.input`);
  const tmpWav = path.join(os.tmpdir(), `${id}.wav`);

  try {
    await fs.promises.writeFile(tmpInput, audioBuf);

    await execFileAsync(ffmpegBin, ['-i', tmpInput, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav], {
      timeout: 30_000,
    });

    const { stdout } = await execFileAsync(whisperBin, ['-m', whisperModel, '-f', tmpWav, '--no-timestamps', '-nt'], {
      timeout: 90_000,
    });

    return stdout.trim() || null;
  } catch (err) {
    log.warn('bo-voice: local whisper.cpp pipeline failed', { err });
    return null;
  } finally {
    for (const f of [tmpInput, tmpWav]) {
      try {
        await fs.promises.unlink(f);
      } catch {
        /* best effort */
      }
    }
  }
}

async function transcribeRemote(audioBuf: Buffer, mime: string, apiKey: string): Promise<string | null> {
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
      log.warn('bo-voice: Whisper API rejected', { status: res.status, body: txt.slice(0, 200) });
      return null;
    }
    return (await res.text()).trim() || null;
  } catch (err) {
    log.warn('bo-voice: Whisper API threw', { err });
    return null;
  }
}

export default async function init(): Promise<void> {
  const env = readEnvFile(['WHISPER_BIN', 'WHISPER_MODEL', 'FFMPEG_BIN', 'WHISPER_API_KEY']);

  const whisperBin = env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
  const whisperModel = env.WHISPER_MODEL || path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');
  const ffmpegBin = env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
  const apiKey = env.WHISPER_API_KEY;

  const hasLocal = (await fileExists(whisperBin)) && (await fileExists(whisperModel)) && (await fileExists(ffmpegBin));

  if (!hasLocal && !apiKey) {
    log.warn('bo-voice: no local whisper.cpp and no WHISPER_API_KEY — voice transcription disabled', {
      whisperBin,
      whisperModel,
      ffmpegBin,
    });
    return;
  }

  const mode = hasLocal ? 'local' : 'openai-api';
  log.info('bo-voice: registered', { mode, whisperBin: hasLocal ? whisperBin : undefined });

  registerInboundTransformer(async (event) => {
    const msg = event.message as { content: string; attachments?: AttachmentLike[] };
    const audioAtts = (msg.attachments ?? []).filter(isAudio);
    if (audioAtts.length === 0) return event;

    const transcripts: string[] = [];
    for (const att of audioAtts) {
      let buf: Buffer | null = null;
      if (att.path && fs.existsSync(att.path)) {
        buf = await fs.promises.readFile(att.path);
      } else if (att.data) {
        buf = Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data, 'base64');
      }
      if (!buf) continue;

      let text: string | null = null;
      if (hasLocal) {
        text = await transcribeLocal(buf, whisperBin, whisperModel, ffmpegBin);
      } else if (apiKey) {
        text = await transcribeRemote(buf, att.mime ?? 'audio/ogg', apiKey);
      }
      if (text) {
        transcripts.push(text);
        log.info('bo-voice: transcribed', { chars: text.length, mime: att.mime, mode });
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
}
