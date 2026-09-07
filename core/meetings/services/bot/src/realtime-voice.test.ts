import { EventEmitter } from 'node:events';

import {
  createRealtimeVoiceSession,
  realtimeVoiceConfigFromEnv,
  resampleFloat32ToPcm16,
  type RealtimeVoiceConfig,
} from './realtime-voice.js';
import type { PcmPlaybackSink } from './tts-playback.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failed += 1;
};

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, any>> = [];

  send(value: string): void {
    this.sent.push(JSON.parse(value) as Record<string, any>);
  }

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.readyState = 3;
  }
}

const pcm = resampleFloat32ToPcm16(new Float32Array(16_000).fill(0.25));
check('16 kHz mono audio is resampled to one second of 24 kHz PCM16', pcm.byteLength === 48_000, String(pcm.byteLength));
check('PCM16 encoding preserves a positive non-zero signal', pcm.readInt16LE(0) > 0, String(pcm.readInt16LE(0)));

const disabled = realtimeVoiceConfigFromEnv({}, 'meeting-1');
check('Realtime is opt-in', disabled.enabled === false);
check('Realtime defaults to the current production model', disabled.model === 'gpt-realtime-2.1', disabled.model);

const socket = new FakeSocket();
const writes: Buffer[] = [];
let begins = 0;
let drains = 0;
let stops = 0;
let latestTranscript = '';
let responseStarts = 0;
const toolCalls: string[] = [];
const playback: PcmPlaybackSink = {
  async begin() { begins += 1; },
  async write(value) { writes.push(Buffer.from(value)); },
  async drain() { drains += 1; },
  stop() { stops += 1; },
};
const config: RealtimeVoiceConfig = {
  apiKey: 'test-key',
  enabled: true,
  model: 'gpt-realtime-2.1',
  projectContext: JSON.stringify({ name: 'Wantok pilot', objective: 'Ship the realtime path' }),
  safetyIdentifier: 'safe-id',
  voice: 'marin',
};
const session = createRealtimeVoiceSession(
  config,
  playback,
  {
    onResponseStarted: () => { responseStarts += 1; },
    onTranscript: (value) => { latestTranscript = value; },
    onToolCall: async (call) => {
      toolCalls.push(`${call.name}:${String(call.arguments.label ?? '')}`);
      return { status: 'captured' };
    },
  },
  () => socket as any,
  () => undefined,
)!;
const started = session.start();
socket.emit('open');
await started;
const update = socket.sent[0];
check('session.update selects audio output and high-eagerness semantic VAD',
  update?.type === 'session.update' &&
  update.session?.output_modalities?.[0] === 'audio' &&
  update.session?.audio?.input?.turn_detection?.type === 'semantic_vad' &&
  update.session?.audio?.input?.turn_detection?.eagerness === 'high' &&
  update.session?.audio?.input?.turn_detection?.interrupt_response === false,
  JSON.stringify(update));
check('the no-op silence tool is available', update.session.tools[0].name === 'wait_for_user');
check('native meeting-memory tools are available', update.session.tools.some((tool: any) => tool.name === 'capture_meeting_memory'));
check('bounded project context is explicitly treated as untrusted reference data',
  update.session.instructions.includes('untrusted reference data') &&
  update.session.instructions.includes('Wantok pilot'));
check('Realtime output is 24 kHz', update.session.audio.output.format.rate === 24_000);

socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' })));
session.appendAudio(new Float32Array(640).fill(0.1), 'Alice');
check('live PCM is appended without waiting for Soniox', socket.sent.some((event) => event.type === 'input_audio_buffer.append'));

socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
check('silent classification does not animate a spoken response', responseStarts === 0, String(responseStarts));
socket.emit('message', Buffer.from(JSON.stringify({
  type: 'response.output_audio.delta',
  item_id: 'item-1',
  delta: Buffer.alloc(960).toString('base64'),
})));
socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Bonjour' })));
socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.done' })));
await new Promise((resolve) => setTimeout(resolve, 20));
check('audio deltas start and stream directly to the browser sink', begins === 1 && writes.length === 1, `${begins}/${writes.length}`);
check('the spoken-response animation starts on first audio only', responseStarts === 1, String(responseStarts));
check('playback drains only after the provider completes audio', drains === 1, String(drains));
check('audio transcript deltas are exposed to the meeting camera', latestTranscript === 'Bonjour', latestTranscript);
check('a realtime answer suppresses only the delayed duplicate chained reply', session.answeredRecently());

socket.emit('message', Buffer.from(JSON.stringify({ type: 'input_audio_buffer.speech_started' })));
check('a new human turn clears duplicate suppression', !session.answeredRecently());

socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
socket.emit('message', Buffer.from(JSON.stringify({
  type: 'response.output_audio.delta',
  item_id: 'item-2',
  delta: Buffer.alloc(960).toString('base64'),
})));
session.appendAudio(new Float32Array(4_096).fill(0.1), 'Alice');
session.appendAudio(new Float32Array(4_096).fill(0.1), 'Alice');
check('barge-in stops playback only after sustained remote speech', stops > 0, String(stops));
check('barge-in cancels provider generation', socket.sent.some((event) => event.type === 'response.cancel'));
check('barge-in truncates the unplayed model item', socket.sent.some((event) => event.type === 'conversation.item.truncate'));

socket.emit('message', Buffer.from(JSON.stringify({
  type: 'response.done',
  response: { output: [{ type: 'function_call', name: 'wait_for_user', call_id: 'call-1', arguments: '{}' }] },
})));
check('silent turns close their function call without creating another response', socket.sent.some((event) => (
  event.type === 'conversation.item.create' && event.item?.call_id === 'call-1'
)));

socket.emit('message', Buffer.from(JSON.stringify({
  type: 'response.done',
  response: { output: [{
    type: 'function_call',
    name: 'capture_meeting_memory',
    call_id: 'call-2',
    arguments: JSON.stringify({ kind: 'task', label: 'Ship the realtime path', certainty: 'confirmed' }),
  }] },
})));
await new Promise((resolve) => setTimeout(resolve, 0));
check('meeting-memory tool calls reach the host callback', toolCalls[0] === 'capture_meeting_memory:Ship the realtime path', toolCalls.join(','));
check('tool output is returned before requesting the spoken continuation', socket.sent.some((event) => (
  event.type === 'conversation.item.create' && event.item?.call_id === 'call-2'
)) && socket.sent.some((event) => event.type === 'response.create'));

await session.stop();

if (failed) {
  console.error(`\n❌ realtime-voice: ${failed} checks FAILED.`);
  process.exit(1);
}
console.log('\n✅ realtime-voice: persistent speech-to-speech transport and streamed playback pass.');
