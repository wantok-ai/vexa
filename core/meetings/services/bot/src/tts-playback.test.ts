import { readFileSync } from 'node:fs';

import { ffmpegArgsForContentType, pacatPlaybackArgs, playbackTailMs } from './tts-playback.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

const pcm = ffmpegArgsForContentType('audio/L16;rate=24000;channels=1');
check('raw PCM declares its input format', pcm.includes('s16le'), pcm.join(' '));
check('raw PCM decoder does not add a second real-time pacing layer', !pcm.includes('-re'), pcm.join(' '));
check('raw PCM decoder writes normalized PCM to stdout', pcm.slice(-3).join(' ') === '-f s16le pipe:1', pcm.join(' '));
check('raw PCM is normalized to 48 kHz mono', pcm.includes('48000') && pcm.includes('1'), pcm.join(' '));

const mp3 = ffmpegArgsForContentType('audio/mpeg');
check('compressed audio relies on ffmpeg input probing', !mp3.slice(0, mp3.indexOf('-i')).includes('s16le'), mp3.join(' '));
check('compressed playback does not add a second real-time pacing layer', !mp3.includes('-re'), mp3.join(' '));
check('compressed audio is normalized to 48 kHz mono', mp3.includes('48000') && mp3.includes('1'), mp3.join(' '));
check('compressed decoder writes PCM to stdout', mp3.slice(-3).join(' ') === '-f s16le pipe:1', mp3.join(' '));
const pacat = pacatPlaybackArgs();
check('pacat drains the dedicated PulseAudio sink', pacat.includes('--device=tts_sink'), pacat.join(' '));
check('pacat requests low-latency 48 kHz mono playback', pacat.includes('--latency-msec=20') && pacat.includes('--rate=48000') && pacat.includes('--channels=1'), pacat.join(' '));
check('keeps a short packetization tail after PulseAudio drains', playbackTailMs >= 200);
const source = readFileSync(new URL('./tts-playback.ts', import.meta.url), 'utf8');
check('keeps the virtual microphone open between utterances', !source.includes('set-source-mute virtual_mic 1'));
check('reports the provider audio duration for live truncation diagnostics', source.includes('audio_bytes='));

if (failed) {
  console.error(`\n❌ TTS playback: ${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\n✅ TTS playback: PCM and compressed provider audio both target the virtual meeting microphone.');
