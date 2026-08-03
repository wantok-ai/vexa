import { readFileSync } from 'node:fs';

import { ffmpegArgsForContentType, playbackTailMs } from './tts-playback.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

const pcm = ffmpegArgsForContentType('audio/L16;rate=24000;channels=1');
check('raw PCM declares its input format', pcm.includes('s16le'), pcm.join(' '));
check('raw PCM playback is paced in real time', pcm.indexOf('-re') < pcm.indexOf('-i'), pcm.join(' '));
check('raw PCM targets the PulseAudio sink', pcm.slice(-3).join(' ') === '-f pulse tts_sink', pcm.join(' '));
check('raw PCM is normalized to 24 kHz mono', pcm.includes('24000') && pcm.includes('1'), pcm.join(' '));

const mp3 = ffmpegArgsForContentType('audio/mpeg');
check('compressed audio relies on ffmpeg probing', !mp3.includes('s16le'), mp3.join(' '));
check('compressed playback is paced in real time', mp3.indexOf('-re') < mp3.indexOf('-i'), mp3.join(' '));
check('compressed audio is normalized to 24 kHz mono', mp3.includes('24000') && mp3.includes('1'), mp3.join(' '));
check('compressed audio targets the PulseAudio sink', mp3.slice(-3).join(' ') === '-f pulse tts_sink', mp3.join(' '));
check('keeps the meeting microphone open long enough to flush the final WebRTC packets', playbackTailMs >= 400);
const source = readFileSync(new URL('./tts-playback.ts', import.meta.url), 'utf8');
check('keeps the virtual microphone open between utterances', !source.includes('set-source-mute virtual_mic 1'));
check('reports the provider audio duration for live truncation diagnostics', source.includes('audio_bytes='));

if (failed) {
  console.error(`\n❌ TTS playback: ${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\n✅ TTS playback: PCM and compressed provider audio both target the virtual meeting microphone.');
