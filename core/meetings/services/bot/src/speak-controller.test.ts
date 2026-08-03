import {
  createSpeakController,
  createBrowserPcmPlaybackSink,
  microphoneStateFromControl,
  type MicrophoneControlSnapshot,
} from './capture-bridge.js';
import type { Invocation } from './config.js';
import type { TtsPlayback } from './tts-playback.js';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

check('recognizes an English muted Meet control', microphoneStateFromControl({
  found: true,
  label: 'Turn on microphone (Ctrl + D)',
}) === 'off');
check('recognizes an English live Meet control', microphoneStateFromControl({
  found: true,
  label: 'Turn off microphone (Ctrl + D)',
}) === 'on');
check('recognizes a French muted Meet control', microphoneStateFromControl({
  found: true,
  label: 'Activer le micro (Ctrl+D)',
}) === 'off');
check('recognizes a French live Meet control', microphoneStateFromControl({
  found: true,
  label: 'Désactiver le micro (Ctrl+D)',
}) === 'on');
check('prefers the explicit muted attribute', microphoneStateFromControl({
  dataIsMuted: 'true',
  found: true,
  label: 'Turn off microphone',
}) === 'off');
check('fails closed on an absent control', microphoneStateFromControl({ found: false }) === 'unknown');

const browserAudioEvents: string[] = [];
(globalThis as any).__wantokAudio = {
  begin: async () => { browserAudioEvents.push('begin'); },
  enqueuePcm: async (base64: string, sampleRate: number) => {
    browserAudioEvents.push(`write:${Buffer.from(base64, 'base64').byteLength}:${sampleRate}`);
  },
  drain: async () => { browserAudioEvents.push('drain'); },
  stop: () => { browserAudioEvents.push('stop'); },
};
const browserSink = createBrowserPcmPlaybackSink({
  evaluate: async (callback: (...args: any[]) => unknown, argument?: unknown) => callback(argument),
} as never);
await browserSink.begin();
await browserSink.write(Buffer.from([1, 2, 3, 4]));
await browserSink.drain();
browserSink.stop();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
check(
  'direct Meet sink preserves PCM order and drains the browser track',
  browserAudioEvents.join('|') === 'begin|write:4:24000|drain|stop',
  JSON.stringify(browserAudioEvents),
);
delete (globalThis as any).__wantokAudio;

const invocation: Invocation = {
  botName: 'Wantok',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  platform: 'google_meet',
  redisUrl: 'redis://localhost:6379',
  voiceAgentEnabled: true,
};

const events: string[] = [];
const snapshots: MicrophoneControlSnapshot[] = [
  { found: true, label: 'Turn on microphone (Ctrl + D)' },
  { found: true, label: 'Turn off microphone (Ctrl + D)' },
];
const page = {
  evaluate: async () => snapshots.shift() ?? { found: false },
  keyboard: {
    press: async (shortcut: string) => { events.push(`shortcut:${shortcut}`); },
  },
  locator: () => ({
    first: () => ({
      click: async () => { events.push('click'); },
    }),
  }),
};
const tts: TtsPlayback = {
  speak: async (text: string) => { events.push(`tts:${text}`); },
  stop: () => { events.push('tts:stop'); },
};
const controller = createSpeakController(page as never, invocation, {
  log: (message) => events.push(`log:${message}`),
  tts,
});
await controller.prepare();
await controller.speak('Bonjour équipe');
check(
  'opens Meet before the first utterance and does not retoggle the microphone while speaking',
  events.filter((event) => event === 'click' || event.startsWith('tts:')).join('|') ===
    'click|tts:Bonjour équipe',
  JSON.stringify(events),
);
check('does not use the shortcut when the control is available', !events.some((event) => event.startsWith('shortcut:')));
check('reports idle after completed speech', controller.isSpeaking() === false);

const fallbackEvents: string[] = [];
const fallback = createSpeakController({
  evaluate: async () => ({ found: false }),
  keyboard: {
    press: async (shortcut: string) => { fallbackEvents.push(shortcut); },
  },
  locator: () => ({ first: () => ({ click: async () => {} }) }),
} as never, invocation, {
  tts: { speak: async () => {}, stop: () => {} },
});
await fallback.speak('Test fallback');
check(
  'uses the locale-independent Meet shortcut to open the mic when the control is absent',
  fallbackEvents.join('|') === 'Control+D',
  JSON.stringify(fallbackEvents),
);

const pendingEvents: string[] = [];
let releaseSpeech: (() => void) | undefined;
const pending = createSpeakController({
  evaluate: async () => ({ found: false }),
  keyboard: {
    press: async (shortcut: string) => { pendingEvents.push(`shortcut:${shortcut}`); },
  },
  locator: () => ({ first: () => ({ click: async () => {} }) }),
} as never, invocation, {
  tts: {
    speak: async () => new Promise<void>((resolve) => { releaseSpeech = resolve; }),
    stop: () => {
      pendingEvents.push('tts:stop');
      releaseSpeech?.();
    },
  },
});
const pendingSpeech = pending.speak('Une longue réponse');
await new Promise<void>((resolve) => setTimeout(resolve, 0));
check('reports speaking while playback is active', pending.isSpeaking() === true);
await pending.stop();
check('reports idle immediately after barge-in', pending.isSpeaking() === false);
await pendingSpeech;
check('barge-in stops the active TTS playback', pendingEvents.includes('tts:stop'), JSON.stringify(pendingEvents));
check(
  'an interrupted turn does not retoggle the meeting microphone',
  pendingEvents.filter((event) => event.startsWith('shortcut:')).length === 1,
  JSON.stringify(pendingEvents),
);

const failedMic = createSpeakController({
  evaluate: async () => ({ found: false }),
  keyboard: {
    press: async () => { throw new Error('mic unavailable'); },
  },
  locator: () => ({ first: () => ({ click: async () => {} }) }),
} as never, invocation, {
  tts: { speak: async () => {}, stop: () => {} },
});
await failedMic.speak('Test unavailable mic');
check('a microphone control failure cannot leave the controller speaking', failedMic.isSpeaking() === false);

if (failures > 0) process.exit(1);
console.log('✅ speak-controller: state-aware Meet microphone control and shortcut fallback are wired.');
