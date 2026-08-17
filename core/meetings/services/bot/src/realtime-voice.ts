import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import WebSocket, { type RawData } from 'ws';

import type { PcmPlaybackSink } from './tts-playback.js';

const INPUT_RATE = 16_000;
const REALTIME_RATE = 24_000;
const OUTPUT_BYTES_PER_MS = REALTIME_RATE * 2 / 1_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const SESSION_RECYCLE_MS = 55 * 60 * 1_000;
const DUPLICATE_SPEECH_WINDOW_MS = 15_000;

interface RealtimeSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

type SocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

export interface RealtimeVoiceConfig {
  apiKey?: string;
  cloudflareToken?: string;
  enabled: boolean;
  gatewayUrl?: string;
  model: string;
  safetyIdentifier: string;
  voice: string;
}

export interface RealtimeVoiceCallbacks {
  onListening?(): void | Promise<void>;
  onResponseStarted?(): void | Promise<void>;
  onTranscript?(text: string): void | Promise<void>;
}

export interface RealtimeVoiceSession {
  appendAudio(pcm: Float32Array, speakerName?: string): void;
  answeredRecently(nowMs?: number): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RealtimeEvent {
  type?: string;
  delta?: string;
  event_id?: string;
  item_id?: string;
  response?: {
    id?: string;
    output?: Array<{
      arguments?: string;
      call_id?: string;
      name?: string;
      type?: string;
    }>;
  };
  error?: { code?: string; message?: string; type?: string };
}

export function realtimeVoiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  meetingId = 'unknown-meeting',
): RealtimeVoiceConfig {
  const enabled = env.REALTIME_VOICE_ENABLED?.trim().toLowerCase() === 'true';
  return {
    apiKey: readSecret(env, 'OPENAI_API_KEY'),
    cloudflareToken: readSecret(env, 'CLOUDFLARE_AI_GATEWAY_TOKEN'),
    enabled,
    gatewayUrl: env.REALTIME_VOICE_GATEWAY_URL?.trim() || undefined,
    model: env.REALTIME_VOICE_MODEL?.trim() || 'gpt-realtime-2.1',
    safetyIdentifier: createHash('sha256').update(meetingId).digest('hex'),
    voice: env.REALTIME_VOICE_OPENAI_VOICE?.trim() || 'marin',
  };
}

export function createRealtimeVoiceSession(
  config: RealtimeVoiceConfig,
  playback: PcmPlaybackSink,
  callbacks: RealtimeVoiceCallbacks = {},
  socketFactory: SocketFactory = defaultSocketFactory,
  log: (message: string) => void = (message) => console.log(`[bot] ${message}`),
): RealtimeVoiceSession | null {
  if (!config.enabled) return null;
  if (!config.apiKey && !config.gatewayUrl) {
    log('[realtime] disabled: no OpenAI key or authenticated AI Gateway URL is configured');
    return null;
  }

  let socket: RealtimeSocket | null = null;
  let stopped = false;
  let ready = false;
  let connecting: Promise<void> | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let recycleTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let playbackChain = Promise.resolve();
  let playbackGeneration = 0;
  let outputStartedAtMs = 0;
  let outputBytes = 0;
  let outputItemId = '';
  let responseCallbackGeneration = -1;
  let transcript = '';
  let lastAnswerAtMs = 0;
  let lastInputSpeechStoppedAtMs = 0;

  const send = (event: Record<string, unknown>): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(event));
    return true;
  };

  const stopPlayback = (truncate: boolean): void => {
    const currentGeneration = ++playbackGeneration;
    void currentGeneration;
    void Promise.resolve(playback.stop()).catch(() => undefined);
    if (truncate && outputItemId && outputStartedAtMs) {
      const elapsedMs = Math.max(0, Date.now() - outputStartedAtMs);
      const scheduledMs = Math.round(outputBytes / OUTPUT_BYTES_PER_MS);
      send({
        type: 'conversation.item.truncate',
        item_id: outputItemId,
        content_index: 0,
        audio_end_ms: Math.min(elapsedMs, scheduledMs),
      });
    }
    outputStartedAtMs = 0;
    outputBytes = 0;
    outputItemId = '';
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((error) => log(`[realtime] reconnect failed: ${safeError(error)}`));
    }, delay);
    reconnectTimer.unref?.();
  };

  const handleToolCalls = (event: RealtimeEvent): void => {
    for (const item of event.response?.output ?? []) {
      if (item.type !== 'function_call' || !item.call_id) continue;
      if (item.name !== 'wait_for_user') {
        log(`[realtime] rejected unsupported tool call ${JSON.stringify(item.name ?? 'unknown')}`);
        continue;
      }
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify({ status: 'waiting' }),
        },
      });
      void callbacks.onListening?.();
      log('[realtime] stayed silent for a non-addressed meeting turn');
    }
  };

  const handleMessage = (raw: RawData): void => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw.toString()) as RealtimeEvent;
    } catch {
      log('[realtime] ignored an invalid provider event');
      return;
    }
    switch (event.type) {
      case 'session.updated':
        ready = true;
        reconnectAttempt = 0;
        log(`[realtime] session ready model=${config.model} voice=${config.voice}`);
        return;
      case 'input_audio_buffer.speech_started':
        // A new human turn invalidates duplicate suppression from the previous answer. This keeps
        // deterministic acknowledgements for tool actions from being hidden by an unrelated reply.
        lastAnswerAtMs = 0;
        stopPlayback(true);
        return;
      case 'input_audio_buffer.speech_stopped':
        lastInputSpeechStoppedAtMs = Date.now();
        return;
      case 'response.created':
        transcript = '';
        outputStartedAtMs = 0;
        outputBytes = 0;
        outputItemId = '';
        responseCallbackGeneration = -1;
        return;
      case 'response.output_audio.delta': {
        if (!event.delta) return;
        const bytes = Buffer.from(event.delta, 'base64');
        const generation = playbackGeneration;
        outputItemId = event.item_id ?? outputItemId;
        outputBytes += bytes.byteLength;
        playbackChain = playbackChain.then(async () => {
          if (generation !== playbackGeneration) return;
          if (!outputStartedAtMs) {
            outputStartedAtMs = Date.now();
            lastAnswerAtMs = outputStartedAtMs;
            if (responseCallbackGeneration !== generation) {
              responseCallbackGeneration = generation;
              void Promise.resolve(callbacks.onResponseStarted?.())
                .catch((error) => log(`[realtime] response callback failed: ${safeError(error)}`));
            }
            const turnToFirstAudioMs = lastInputSpeechStoppedAtMs
              ? outputStartedAtMs - lastInputSpeechStoppedAtMs
              : null;
            log(`[realtime] first audio${turnToFirstAudioMs === null ? '' : ` turn_to_first_audio_ms=${turnToFirstAudioMs}`}`);
            await playback.begin();
          }
          await playback.write(bytes);
        }).catch((error) => log(`[realtime] playback failed: ${safeError(error)}`));
        return;
      }
      case 'response.output_audio_transcript.delta':
        if (!event.delta) return;
        transcript += event.delta;
        void callbacks.onTranscript?.(transcript);
        return;
      case 'response.output_audio.done': {
        const generation = playbackGeneration;
        playbackChain = playbackChain.then(async () => {
          if (generation !== playbackGeneration || !outputStartedAtMs) return;
          await playback.drain();
          log(`[realtime] playback complete transcript_chars=${transcript.length}`);
          await callbacks.onListening?.();
        }).catch((error) => log(`[realtime] drain failed: ${safeError(error)}`));
        return;
      }
      case 'response.done':
        handleToolCalls(event);
        return;
      case 'error':
        log(`[realtime] provider error code=${JSON.stringify(event.error?.code ?? 'unknown')} message=${JSON.stringify((event.error?.message ?? 'unknown').slice(0, 240))}`);
        return;
      default:
        return;
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped || ready) return;
    if (connecting) return connecting;
    connecting = new Promise<void>((resolve, reject) => {
      const url = realtimeUrl(config);
      const headers = realtimeHeaders(config);
      const next = socketFactory(url, headers);
      socket = next;
      let opened = false;
      next.on('open', () => {
        opened = true;
        send(sessionUpdate(config));
        if (recycleTimer) clearTimeout(recycleTimer);
        recycleTimer = setTimeout(() => {
          ready = false;
          next.close(1000, 'session recycle');
        }, SESSION_RECYCLE_MS);
        recycleTimer.unref?.();
        resolve();
      });
      next.on('message', handleMessage);
      next.on('error', (error) => {
        if (!opened) reject(error);
        else log(`[realtime] socket error: ${safeError(error)}`);
      });
      next.on('close', (code, reason) => {
        if (socket === next) socket = null;
        ready = false;
        if (!opened) reject(new Error(`WebSocket closed before ready (${code})`));
        if (!stopped) {
          log(`[realtime] socket closed code=${code} reason=${JSON.stringify(reason.toString().slice(0, 120))}`);
          scheduleReconnect();
        }
      });
    }).finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const sendSilence = (): void => {
    silenceTimer = null;
    if (!ready) return;
    const silence = Buffer.alloc(Math.round(REALTIME_RATE * 0.6) * 2);
    for (let offset = 0; offset < silence.length; offset += 1_920) {
      send({ type: 'input_audio_buffer.append', audio: silence.subarray(offset, offset + 1_920).toString('base64') });
    }
  };

  return {
    appendAudio(pcm: Float32Array): void {
      if (!ready || !pcm.length) return;
      const encoded = resampleFloat32ToPcm16(pcm, INPUT_RATE, REALTIME_RATE);
      for (let offset = 0; offset < encoded.length; offset += 1_920) {
        send({ type: 'input_audio_buffer.append', audio: encoded.subarray(offset, offset + 1_920).toString('base64') });
      }
      if (silenceTimer) clearTimeout(silenceTimer);
      // The Meet capture worklet emits 256 ms frames. A 340 ms inactivity gap is therefore a
      // real turn boundary, after which synthetic silence lets server VAD close without waiting.
      silenceTimer = setTimeout(sendSilence, 340);
      silenceTimer.unref?.();
    },
    answeredRecently(nowMs = Date.now()): boolean {
      return lastAnswerAtMs > 0 && nowMs - lastAnswerAtMs <= DUPLICATE_SPEECH_WINDOW_MS;
    },
    async start(): Promise<void> {
      await connect();
    },
    async stop(): Promise<void> {
      stopped = true;
      ready = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (recycleTimer) clearTimeout(recycleTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
      stopPlayback(false);
      const active = socket;
      socket = null;
      active?.close(1000, 'meeting ended');
      await playbackChain.catch(() => undefined);
    },
  };
}

export function resampleFloat32ToPcm16(
  input: Float32Array,
  inputRate = INPUT_RATE,
  outputRate = REALTIME_RATE,
): Buffer {
  if (!input.length) return Buffer.alloc(0);
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = Buffer.allocUnsafe(outputLength * 2);
  const ratio = inputRate / outputRate;
  for (let index = 0; index < outputLength; index++) {
    const position = index * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    const sample = Math.max(-1, Math.min(1, input[left]! + (input[right]! - input[left]!) * fraction));
    output.writeInt16LE(sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), index * 2);
  }
  return output;
}

function realtimeUrl(config: RealtimeVoiceConfig): string {
  if (config.gatewayUrl) {
    const url = new URL(config.gatewayUrl);
    if (!url.searchParams.has('model')) url.searchParams.set('model', config.model);
    return url.toString();
  }
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`;
}

function realtimeHeaders(config: RealtimeVoiceConfig): Record<string, string> {
  return {
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...(config.cloudflareToken ? { 'cf-aig-authorization': `Bearer ${config.cloudflareToken}` } : {}),
    'cf-aig-collect-log-payload': 'false',
    'OpenAI-Safety-Identifier': config.safetyIdentifier,
  };
}

function sessionUpdate(config: RealtimeVoiceConfig): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: config.model,
      output_modalities: ['audio'],
      instructions: [
        'You are Wantok, an AI teammate physically present in a work meeting.',
        'Understand and answer in the language currently spoken. Speak naturally and start the useful content immediately.',
        'Remain silent unless someone directly addresses Wantok, the same person clearly continues a conversation with you, or a short intervention is essential to prevent an important mistake or unblock a decision.',
        'For background conversation, filler, side conversations, uncertain addressees, and ordinary statements, call wait_for_user immediately and emit no audio.',
        'For requests that create or modify data in external tools, call wait_for_user and remain silent; Wantok\'s deterministic action lane will execute and acknowledge them.',
        'Default to one or two complete spoken sentences. Give a longer complete answer only when explicitly requested. Never end with a sentence fragment.',
        'Do not invent meeting facts, decisions, actions, owners, dates, web results, or tool outcomes.',
      ].join('\n'),
      max_output_tokens: 768,
      reasoning: { effort: 'low' },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REALTIME_RATE },
          noise_reduction: { type: 'near_field' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.55,
            prefix_padding_ms: 400,
            silence_duration_ms: 350,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: 'audio/pcm' },
          voice: config.voice,
          speed: 1.08,
        },
      },
      tools: [{
        type: 'function',
        name: 'wait_for_user',
        description: 'Stay completely silent because this meeting turn does not require Wantok to respond.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }],
      tool_choice: 'auto',
      truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
    },
  };
}

function defaultSocketFactory(url: string, headers: Record<string, string>): RealtimeSocket {
  return new WebSocket(url, { headers });
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const path = env[`${name}_FILE`]?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
