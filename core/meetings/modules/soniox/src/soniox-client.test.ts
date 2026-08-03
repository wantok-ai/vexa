import { EventEmitter } from 'node:events';
import { SonioxTranscriptionClient, SonioxTranscriptionError } from './index.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

class FakeSocket extends EventEmitter {
  readonly sent: Array<string | Buffer> = [];
  closed = false;
  terminated = false;
  response: 'success' | 'low_confidence_short' | 'payment' | 'rate' | 'timeout' | 'network' = 'success';

  send(data: string | Buffer): void {
    this.sent.push(data);
    if (data !== '') return;
    queueMicrotask(() => {
      if (this.response === 'network') {
        this.emit('error', new Error('network down'));
        return;
      }
      if (this.response === 'payment') {
        this.emit('message', Buffer.from(JSON.stringify({
          error_type: 'project_monthly_budget_exhausted', error_code: 402,
          error_message: 'Project monthly budget exhausted', request_id: 'req-1',
        })), false);
        return;
      }
      if (this.response === 'rate') {
        this.emit('message', Buffer.from(JSON.stringify({
          error_type: 'limit_exceeded', error_code: 429, error_message: 'Concurrent request limit exceeded',
        })), false);
        return;
      }
      if (this.response === 'timeout') {
        this.emit('message', Buffer.from(JSON.stringify({
          error_type: 'request_timeout', error_code: 408, error_message: 'Request timed out',
        })), false);
        return;
      }
      if (this.response === 'low_confidence_short') {
        this.emit('message', Buffer.from(JSON.stringify({ tokens: [
          { text: 'Fine', start_ms: 0, end_ms: 280, confidence: 0.18, is_final: true, language: 'en' },
          { text: '.', start_ms: 280, end_ms: 300, confidence: 0.2, is_final: true, language: 'en' },
       ] })), false);
        this.emit('message', Buffer.from(JSON.stringify({ finished: true })), false);
        return;
      }
      this.emit('message', Buffer.from(JSON.stringify({ tokens: [
        { text: 'Hello', start_ms: 0, end_ms: 300, confidence: 0.98, is_final: true, language: 'en' },
        { text: ' wor', start_ms: 300, end_ms: 500, confidence: 0.91, is_final: false, language: 'en' },
        { text: '<end>', start_ms: 500, end_ms: 500, confidence: 1, is_final: true, language: 'en' },
      ] })), false);
      this.emit('message', Buffer.from(JSON.stringify({ tokens: [
        { text: ' world', start_ms: 300, end_ms: 700, confidence: 0.97, is_final: true, language: 'en' },
      ] })), false);
      this.emit('message', Buffer.from(JSON.stringify({ finished: true })), false);
    });
  }

  close(): void { this.closed = true; }
  terminate(): void { this.terminated = true; }
}

async function main(): Promise<void> {
  {
    const socket = new FakeSocket();
    socket.response = 'low_confidence_short';
    const client = new SonioxTranscriptionClient({
      serviceUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket', apiToken: 'test-key', maxRetries: 0,
      socketFactory: () => socket as never,
    });
    const promise = client.transcribe(new Float32Array(4800).fill(0.01), 'en');
    socket.emit('open');
    const result = await promise;
    check('low-confidence short Soniox artifacts are omitted', result.text === '' && result.segments.length === 0, JSON.stringify(result));
  }

  {
    const socket = new FakeSocket();
    const client = new SonioxTranscriptionClient({
      serviceUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      apiToken: 'test-key', model: 'stt-rt-v5', maxRetries: 0,
      languageHintsStrict: true,
      contextGeneral: [{ key: 'setting', value: 'Business team meeting' }],
      contextTerms: ['Wantok', 'Cloudflare', 'Wantok'],
      clientReferenceId: 'wantok-session-42',
      socketFactory: () => socket as never,
    });
    const resultPromise = client.transcribe(
      new Float32Array(3200).fill(0.5),
      'en',
      'We are discussing the Wantok launch.',
    );
    socket.emit('open');
    const result = await resultPromise;
    const config = JSON.parse(socket.sent[0] as string);
    const binaryFrames = socket.sent.filter(Buffer.isBuffer);
    check('configuration is the first frame', config.api_key === 'test-key' && config.model === 'stt-rt-v5');
    check('raw audio contract is 16 kHz mono pcm_s16le', config.audio_format === 'pcm_s16le' && config.sample_rate === 16000 && config.num_channels === 1);
    check('language hint is carried to Soniox', JSON.stringify(config.language_hints) === '["en"]', JSON.stringify(config.language_hints));
    check('strict language bias is carried to Soniox', config.language_hints_strict === true);
    check('custom vocabulary is carried to Soniox', JSON.stringify(config.context?.terms) === '["Wantok","Cloudflare"]', JSON.stringify(config.context));
    check('opaque session reference is carried to Soniox', config.client_reference_id === 'wantok-session-42');
    check('structured meeting context is carried to Soniox', config.context?.general?.[0]?.value === 'Business team meeting', JSON.stringify(config.context));
    check('previous transcript context is carried to Soniox', config.context?.text === 'We are discussing the Wantok launch.', JSON.stringify(config.context));
    check('local Meet turn detection disables duplicate Soniox endpointing', config.enable_endpoint_detection === false);
    check('audio is chunked into binary PCM frames', binaryFrames.length === 2 && binaryFrames.every((frame) => frame.length === 3200), binaryFrames.map((frame) => frame.length).join(','));
    check('stream is terminated by an empty text frame', socket.sent.at(-1) === '');
    check('final tokens replace the non-final tail without duplicate text', result.text === 'Hello world', result.text);
    check('Soniox control tokens never leak into transcript text', !result.text.includes('<end>'), result.text);
    check('timestamps and confidence are normalized', result.segments[0]?.end === 0.7 && result.segments[0]?.words?.[1]?.probability === 0.97, JSON.stringify(result.segments));
    check('provider language is preserved', result.language === 'en', result.language);
    check('successful stream closes gracefully', socket.closed && !socket.terminated);
  }

  {
    const socket = new FakeSocket();
    const client = new SonioxTranscriptionClient({
      serviceUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      apiToken: 'test-key',
      maxRetries: 0,
      contextTerms: Array.from({ length: 100 }, (_, index) => `${index}-${'x'.repeat(158)}`),
      socketFactory: () => socket as never,
    });
    const resultPromise = client.transcribe(new Float32Array(1600));
    socket.emit('open');
    await resultPromise;
    const config = JSON.parse(socket.sent[0] as string);
    check(
      'custom vocabulary stays below the Soniox context budget',
      config.context.terms.reduce((length: number, term: string) => length + term.length, 0) <= 8_000,
    );
  }

  for (const [response, expected] of [
    ['rate', 'rate_limited'],
    ['timeout', 'timeout'],
  ] as const) {
    const socket = new FakeSocket();
    socket.response = response;
    const client = new SonioxTranscriptionClient({
      serviceUrl: 'wss://stt-rt.soniox.com/transcribe-websocket', apiToken: 'test-key', maxRetries: 0,
      socketFactory: () => socket as never,
    });
    const promise = client.transcribe(new Float32Array(1600));
    socket.emit('open');
    let fault: SonioxTranscriptionError | undefined;
    try { await promise; } catch (error) { if (error instanceof SonioxTranscriptionError) fault = error; }
    check(`${response} provider failure is classified`, fault?.kind === expected, fault?.kind);
    check(`${response} provider failure is retryable`, fault?.retryable === true);
  }

  {
    const socket = new FakeSocket();
    socket.response = 'payment';
    const client = new SonioxTranscriptionClient({
      serviceUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket', apiToken: 'test-key', maxRetries: 3,
      retryDelayMs: 1, socketFactory: () => socket as never,
    });
    const promise = client.transcribe(new Float32Array(1600), 'fr');
    socket.emit('open');
    let fault: SonioxTranscriptionError | undefined;
    try { await promise; } catch (error) { if (error instanceof SonioxTranscriptionError) fault = error; }
    check('balance failure becomes a typed payment fault', fault?.kind === 'payment_required', fault?.kind);
    check('payment fault is permanent and not retried', fault?.retryable === false && socket.terminated);
  }

  {
    const client = new SonioxTranscriptionClient({ serviceUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket' });
    let fault: SonioxTranscriptionError | undefined;
    try { await client.transcribe(new Float32Array(10)); } catch (error) { if (error instanceof SonioxTranscriptionError) fault = error; }
    check('missing key fails before opening a socket', fault?.kind === 'unauthorized' && fault.retryable === false);
  }

  if (failed) {
    console.error(`\n❌ Soniox adapter: ${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\n✅ Soniox adapter: config → binary PCM → graceful finalize → normalized STT result and typed faults.');
}

void main();
