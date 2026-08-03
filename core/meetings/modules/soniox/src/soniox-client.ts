import WebSocket, { type RawData } from 'ws';

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  words?: TranscriptionWord[];
}

export interface TranscriptionResult {
  text: string;
  language: string;
  language_probability?: number;
  duration: number;
  segments: TranscriptionSegment[];
}

export type SonioxTranscriptionFaultKind =
  | 'payment_required'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'bad_request'
  | 'unknown';

export class SonioxTranscriptionError extends Error {
  readonly source = 'stt' as const;

  constructor(
    readonly kind: SonioxTranscriptionFaultKind,
    readonly detail: string | undefined,
    readonly retryable: boolean,
  ) {
    super(`stt ${kind}${detail ? `: ${detail}` : ''}`);
    this.name = 'SonioxTranscriptionError';
  }
}

interface SonioxToken {
  text?: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  is_final?: boolean;
  language?: string;
}

interface SonioxResponse {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_type?: string;
  error_code?: string | number;
  error_message?: string;
  more_info?: string;
  message?: string;
  request_id?: string;
}

interface SonioxSocket {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  send(data: string | Buffer, callback?: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
}

type SonioxSocketFactory = (url: string) => SonioxSocket;

export interface SonioxTranscriptionClientConfig {
  /** Soniox real-time WebSocket endpoint matching the API key's project region. */
  serviceUrl: string;
  /** Soniox API key. The caller must supply it through a secret-backed invocation file. */
  apiToken?: string;
  /** Soniox real-time model. Default: stt-rt-v5. */
  model?: string;
  /** Input sample rate. Default: 16000. */
  sampleRate?: number;
  /** Extra BCP-47/ISO language hints sent with each stream. */
  languageHints?: string[];
  /** Strongly prefer output in languageHints. Soniox documents this as best-effort. */
  languageHintsStrict?: boolean;
  /** Short structured context sent to Soniox for domain adaptation. */
  contextGeneral?: Array<{ key: string; value: string }>;
  /** Important product, person, and domain terms Soniox should recognize exactly. */
  contextTerms?: string[];
  /** Opaque Wantok session identifier exposed in Soniox usage logs. */
  clientReferenceId?: string;
  /** Maximum WebSocket session duration. Default: 30000 ms. */
  timeoutMs?: number;
  /** Transient retry count after the first attempt. Default: 2. */
  maxRetries?: number;
  /** Base exponential retry delay. Default: 250 ms. */
  retryDelayMs?: number;
  /** Test seam for an in-memory WebSocket. */
  socketFactory?: SonioxSocketFactory;
}

function classifyProviderError(response: SonioxResponse): SonioxTranscriptionError {
  const type = (response.error_type ?? '').toLowerCase();
  const code = String(response.error_code ?? '').toLowerCase();
  const signal = `${type} ${code}`;
  const detail = [
    response.error_code,
    response.error_message ?? response.message,
    response.more_info,
    response.request_id ? `request ${response.request_id}` : undefined,
  ]
    .filter(Boolean).join(' — ') || response.error_type;

  if (/payment|balance|credit|fund|(?:quota|budget)_exhausted/.test(signal)) {
    return new SonioxTranscriptionError('payment_required', detail, false);
  }
  if (/auth|api_key|permission|forbidden/.test(signal)) {
    return new SonioxTranscriptionError('unauthorized', detail, false);
  }
  if (/rate|too_many|resource_exhausted|limit_exceeded/.test(signal)) {
    return new SonioxTranscriptionError('rate_limited', detail, true);
  }
  if (/timeout/.test(signal)) {
    return new SonioxTranscriptionError('timeout', detail, true);
  }
  if (/invalid|bad_request|unsupported/.test(signal)) {
    return new SonioxTranscriptionError('bad_request', detail, false);
  }
  if (/server|unavailable|internal|overload/.test(signal)) {
    return new SonioxTranscriptionError('unavailable', detail, true);
  }
  return new SonioxTranscriptionError('unknown', detail, false);
}

function float32ToPcmS16le(audio: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(audio.length * 2);
  for (let index = 0; index < audio.length; index++) {
    const sample = Math.max(-1, Math.min(1, audio[index]));
    pcm.writeInt16LE(sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), index * 2);
  }
  return pcm;
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function normalizedLanguage(tokens: SonioxToken[], configured?: string): string {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (!token.language) continue;
    counts.set(token.language, (counts.get(token.language) ?? 0) + 1);
  }
  let selected = configured && configured !== 'auto' ? configured : 'unknown';
  let maximum = 0;
  for (const [language, count] of counts) {
    if (count > maximum) {
      selected = language;
      maximum = count;
    }
  }
  return selected;
}

function normalizedResult(tokens: SonioxToken[], duration: number, configuredLanguage?: string): TranscriptionResult {
  // Soniox control tokens are protocol events, never transcript text. `<end>` marks a semantic
  // utterance endpoint and `<fin>` marks stream finalization.
  const controlTokens = new Set(['<end>', '<fin>']);
  const visible = tokens.filter((token) => token.text && !controlTokens.has(token.text.trim().toLowerCase()));
  const text = visible.map((token) => token.text).join('').trim();
  if (!visible.length || !text) {
    return { text: '', language: normalizedLanguage(visible, configuredLanguage), duration, segments: [] };
  }
  const start = Math.max(0, (visible[0].start_ms ?? 0) / 1000);
  const end = Math.max(start, (visible[visible.length - 1].end_ms ?? duration * 1000) / 1000);
  const words = visible.map((token) => ({
    word: token.text ?? '',
    start: Math.max(0, (token.start_ms ?? 0) / 1000),
    end: Math.max(0, (token.end_ms ?? token.start_ms ?? 0) / 1000),
    probability: token.confidence ?? 0,
  }));
  return {
    text,
    language: normalizedLanguage(visible, configuredLanguage),
    duration,
    segments: [{ start, end, text, words }],
  };
}

export class SonioxTranscriptionClient {
  private readonly serviceUrl: string;
  private readonly apiToken: string | undefined;
  private readonly model: string;
  private readonly sampleRate: number;
  private readonly languageHints: string[];
  private readonly languageHintsStrict: boolean;
  private readonly contextGeneral: Array<{ key: string; value: string }>;
  private readonly contextTerms: string[];
  private readonly clientReferenceId: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly socketFactory: SonioxSocketFactory;

  constructor(config: SonioxTranscriptionClientConfig) {
    this.serviceUrl = config.serviceUrl;
    this.apiToken = config.apiToken;
    this.model = config.model ?? 'stt-rt-v5';
    this.sampleRate = config.sampleRate ?? 16000;
    this.languageHints = config.languageHints ?? [];
    this.languageHintsStrict = config.languageHintsStrict ?? false;
    this.contextGeneral = normalizeGeneralContext(config.contextGeneral ?? []);
    this.contextTerms = normalizeContextTerms(config.contextTerms ?? []);
    this.clientReferenceId = config.clientReferenceId?.trim().slice(0, 256) ?? '';
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryDelayMs = config.retryDelayMs ?? 250;
    this.socketFactory = config.socketFactory ?? ((url) => new WebSocket(url));
  }

  async transcribe(audio: Float32Array, language?: string, prompt?: string): Promise<TranscriptionResult> {
    if (!this.apiToken) {
      throw new SonioxTranscriptionError('unauthorized', 'Soniox API key is missing', false);
    }
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.transcribeOnce(audio, language, prompt);
      } catch (error) {
        const fault = error instanceof SonioxTranscriptionError
          ? error
          : new SonioxTranscriptionError('unavailable', error instanceof Error ? error.message : String(error), true);
        if (!fault.retryable || attempt === this.maxRetries) throw fault;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** attempt));
      }
    }
    throw new SonioxTranscriptionError('unknown', 'retry loop exhausted', false);
  }

  private transcribeOnce(audio: Float32Array, language?: string, prompt?: string): Promise<TranscriptionResult> {
    const duration = audio.length / this.sampleRate;
    const pcm = float32ToPcmS16le(audio);
    const hints = [...new Set([
      ...this.languageHints,
      ...(language && language !== 'auto' ? [language] : []),
    ].filter(Boolean))];
    const contextText = normalizeContextText(prompt);
    const context = {
      ...(this.contextGeneral.length ? { general: this.contextGeneral } : {}),
      ...(contextText ? { text: contextText } : {}),
      ...(this.contextTerms.length ? { terms: this.contextTerms } : {}),
    };

    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(this.serviceUrl);
      let settled = false;
      let finalTokens: SonioxToken[] = [];
      let nonFinalTokens: SonioxToken[] = [];

      const finish = (result: TranscriptionResult | SonioxTranscriptionError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (result instanceof SonioxTranscriptionError) {
          socket.terminate();
          reject(result);
        } else {
          socket.close();
          resolve(result);
        }
      };

      const timeout = setTimeout(() => {
        finish(new SonioxTranscriptionError('timeout', `Soniox stream exceeded ${this.timeoutMs} ms`, true));
      }, this.timeoutMs);
      (timeout as { unref?: () => void }).unref?.();

      socket.on('open', () => {
        try {
          socket.send(JSON.stringify({
            api_key: this.apiToken,
            model: this.model,
            audio_format: 'pcm_s16le',
            sample_rate: this.sampleRate,
            num_channels: 1,
            enable_language_identification: true,
            // The Meet lane already owns turn detection from per-participant audio gaps. Enabling
            // Soniox semantic endpointing on these pre-cut windows can split a sentence a second
            // time and slightly reduce recognition accuracy; the empty frame below finalizes the
            // stream explicitly.
            enable_endpoint_detection: false,
            ...(this.clientReferenceId ? { client_reference_id: this.clientReferenceId } : {}),
            ...(hints.length ? { language_hints: hints } : {}),
            ...(hints.length && this.languageHintsStrict ? { language_hints_strict: true } : {}),
            ...(Object.keys(context).length ? { context } : {}),
          }));
          const bytesPer100Ms = Math.max(2, Math.floor(this.sampleRate / 10) * 2);
          for (let offset = 0; offset < pcm.length; offset += bytesPer100Ms) {
            socket.send(pcm.subarray(offset, Math.min(offset + bytesPer100Ms, pcm.length)));
          }
          socket.send('');
        } catch (error) {
          finish(new SonioxTranscriptionError('unavailable', error instanceof Error ? error.message : String(error), true));
        }
      });

      socket.on('message', (data, isBinary) => {
        if (isBinary || settled) return;
        let response: SonioxResponse;
        try {
          response = JSON.parse(rawDataToText(data)) as SonioxResponse;
        } catch (error) {
          finish(new SonioxTranscriptionError('unavailable', `invalid Soniox response: ${String(error)}`, true));
          return;
        }
        if (response.error_type) {
          finish(classifyProviderError(response));
          return;
        }
        if (response.tokens) {
          finalTokens = finalTokens.concat(response.tokens.filter((token) => token.is_final));
          nonFinalTokens = response.tokens.filter((token) => !token.is_final);
        }
        if (response.finished) {
          finish(normalizedResult(finalTokens.concat(nonFinalTokens), duration, language));
        }
      });

      socket.on('error', (error) => {
        finish(new SonioxTranscriptionError('unavailable', error.message, true));
      });
      socket.on('close', (code, reason) => {
        if (!settled) {
          finish(new SonioxTranscriptionError(
            'unavailable',
            `Soniox stream closed before finished (${code}${reason.length ? `: ${reason.toString()}` : ''})`,
            true,
          ));
        }
      });
    });
  }
}

function normalizeContextTerms(terms: string[]): string[] {
  const unique = new Map<string, string>();
  let usedCharacters = 0;
  for (const term of terms) {
    const value = term.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    const previous = unique.get(key);
    const nextCharacters = usedCharacters - (previous?.length ?? 0) + value.length;
    if (nextCharacters > 8_000) break;
    unique.set(key, value);
    usedCharacters = nextCharacters;
    if (unique.size >= 100) break;
  }
  return [...unique.values()];
}

function normalizeContextText(text?: string): string {
  return text?.trim().replace(/\s+/g, ' ').slice(-1_000) ?? '';
}

function normalizeGeneralContext(items: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return items.slice(0, 10).flatMap((item) => {
    const key = item.key.trim().replace(/\s+/g, ' ').slice(0, 80);
    const value = item.value.trim().replace(/\s+/g, ' ').slice(0, 240);
    return key && value ? [{ key, value }] : [];
  });
}
