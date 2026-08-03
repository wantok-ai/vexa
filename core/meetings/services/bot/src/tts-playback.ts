/**
 * TTS playback adapter (2b) — the OS-level half of the SPEAK path.  // L4 (O6/VM).
 *
 * The browser half (unmute the meeting-UI mic) lives in capture-bridge.ts's SpeakController; this
 * is the audio half: synthesize `text` via the Vexa TTS service and play the returned audio through
 * the container's PulseAudio `tts_sink` (→ `virtual_mic`, which Chromium captures as its mic). The
 * `tts_sink → virtual_mic` graph is created by entrypoint.sh; here we only unmute it during
 * playback, decode it with FFmpeg into the PulseAudio sink, and re-mute after.
 *
 * Ported from the production bot
 *   services/vexa-bot/core/src/services/tts-playback.ts (synthesizeViaTtsService + (un)mute).
 * acts.v1 `speak` already carries {text, voice} — no contract change. Config is infrastructure
 * (the TTS service URL/token), read from `TTS_SERVICE_URL` and either
 * `TTS_API_TOKEN` or `TTS_API_TOKEN_FILE`,
 * NOT the sealed invocation.v1. Gated by the SpeakController on inv.voiceAgentEnabled.
 *
 * Node-only (child_process + http/https) — no DOM, no workspace imports → gate:isolation-clean.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import http, { type ClientRequest } from 'node:http';
import { PassThrough } from 'node:stream';

export const playbackTailMs = 500;

export function ffmpegArgsForContentType(contentType: string | undefined): string[] {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (/audio\/(?:l16|pcm)|application\/octet-stream/i.test(contentType ?? '')) {
    args.push('-f', 's16le', '-ar', '24000', '-ac', '1');
  }
  // PulseAudio accepts data faster than it plays it. Without real-time input pacing, FFmpeg can
  // exit after buffering a whole phrase and the source is muted before WebRTC hears the tail.
  args.push('-re', '-i', 'pipe:0', '-vn', '-ar', '24000', '-ac', '1', '-f', 'pulse', 'tts_sink');
  return args;
}

function setTtsMute(muted: boolean, log: (m: string) => void): void {
  const v = muted ? '1' : '0';
  try {
    execSync(`pactl set-sink-mute tts_sink ${v}`, { stdio: 'pipe' });
    execSync(`pactl set-source-mute virtual_mic ${v}`, { stdio: 'pipe' });
  } catch (err) {
    log(`[tts] pactl ${muted ? 'mute' : 'unmute'} failed: ${(err as Error).message}`);
  }
}

export interface TtsPlayback {
  /** Synthesize `text` (voice optional) and play it into the meeting via tts_sink. Resolves when
   *  playback finishes. Best-effort: a synthesis/playback failure logs + resolves (never throws out
   *  — the voice handler must not break the orchestrator). */
  speak(text: string, voice?: string): Promise<void>;
  /** Interrupt any in-flight playback (barge-in) + re-mute. */
  stop(): void;
}

/** Build a TtsPlayback that decodes the TTS response into the virtual microphone sink. */
export function createTtsPlayback(log: (m: string) => void = () => { /* */ }): TtsPlayback {
  let proc: ChildProcess | null = null;
  let request: ClientRequest | null = null;
  let generation = 0;

  const cancelActive = (): void => {
    if (request) {
      try { request.destroy(); } catch { /* */ }
      request = null;
    }
    if (proc) {
      try { proc.stdin?.destroy(); proc.kill('SIGKILL'); } catch { /* */ }
      proc = null;
    }
    setTtsMute(true, log);
  };

  const stop = (): void => {
    generation++;
    cancelActive();
  };

  const speak = async (text: string, voice = 'auto'): Promise<void> => {
    const startedAt = Date.now();
    const base = process.env.TTS_SERVICE_URL?.trim();
    if (!base) { log('[tts] TTS_SERVICE_URL not set — speak is a no-op'); return; }
    const postData = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'pcm' });
    let url: URL;
    try { url = new URL(`${base.replace(/\/$/, '')}/v1/audio/speech`); }
    catch { log(`[tts] bad TTS_SERVICE_URL: ${base}`); return; }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(postData)),
    };
    const token = readSecret('TTS_API_TOKEN');
    if (token) headers['X-API-Key'] = token;
    generation++;
    cancelActive();
    const turn = generation;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (generation === turn) {
          request = null;
          proc = null;
          setTtsMute(true, log);
        }
        resolve();
      };
      const req = (url.protocol === 'https:' ? https : http).request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }, (res) => {
        if (generation !== turn) {
          res.resume();
          finish();
          return;
        }
        if (res.statusCode !== 200) {
          let body = ''; res.on('data', (c) => (body += c));
          res.on('end', () => { log(`[tts] service ${res.statusCode}: ${body.slice(0, 120)}`); finish(); });
          return;
        }
        const providerHeadersMs = Date.now() - startedAt;
        const serverTiming = res.headers['server-timing'];
        log(`[tts] latency provider_headers_ms=${providerHeadersMs}${serverTiming ? ` upstream=${serverTiming}` : ''}`);
        const p = spawn('ffmpeg', ffmpegArgsForContentType(res.headers['content-type']), {
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        proc = p;
        const meteredAudio = new PassThrough();
        let firstAudioByteAt: number | null = null;
        meteredAudio.once('data', () => {
          firstAudioByteAt = Date.now();
          setTtsMute(false, log);                     // open the mic only when provider audio starts
          log(`[tts] latency first_audio_byte_ms=${firstAudioByteAt - startedAt}`);
        });
        p.stderr?.on('data', (d: Buffer) => log(`[tts] ffmpeg: ${d.toString().trim()}`));
        let playbackEnded = false;
        const done = (withTail: boolean) => {
          if (playbackEnded) return;
          playbackEnded = true;
          const complete = () => {
            if (firstAudioByteAt !== null) {
              log(`[tts] latency playback_ms=${Date.now() - firstAudioByteAt} total_ms=${Date.now() - startedAt} tail_ms=${withTail ? playbackTailMs : 0}`);
            }
            finish();
          };
          if (withTail && generation === turn && firstAudioByteAt !== null) {
            setTimeout(complete, playbackTailMs);
          } else {
            complete();
          }
        };
        p.on('exit', (code) => done(code === 0));
        p.on('error', (e) => { log(`[tts] ffmpeg error: ${String(e)}`); done(false); });
        res.pipe(meteredAudio).pipe(p.stdin!);        // decode provider audio into the mic sink
      });
      request = req;
      req.on('error', (e) => {
        if (generation === turn) log(`[tts] request error: ${String(e)}`);
        finish();
      });
      req.write(postData); req.end();
    });
  };

  return { speak, stop };
}

function readSecret(name: 'TTS_API_TOKEN'): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const path = process.env[`${name}_FILE`]?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
