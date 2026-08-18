import { createRemoteAudioActivityTap } from './aloneness.js';
import { createBargeInRemoteAudioTap, type BargeInTarget } from './barge-in.js';

let failures = 0;
const check = (name: string, condition: boolean): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}`);
  if (!condition) failures++;
};

async function main(): Promise<void> {
  let at = 1_000;
  let speaking = true;
  let stops = 0;
  const target: BargeInTarget = {
    isSpeaking: () => speaking,
    async stop() {
      stops++;
      speaking = false;
    },
  };
  const base = createRemoteAudioActivityTap({ now: () => at });
  const tap = createBargeInRemoteAudioTap(base, () => target, { now: () => at });
  tap.ready();

  tap.observeRemoteEnergy(0.0001);
  tap.observeRemoteEnergy(0.003);
  await Promise.resolve();
  check('noise and one speech frame do not interrupt', stops === 0);

  at += 100;
  tap.observeRemoteEnergy(0.004);
  await Promise.resolve();
  check('two nearby speech frames interrupt an active response', stops === 1);
  check('remote activity still updates the aloneness source', base.snapshot().lastRemoteAudioAt === at);

  at += 100;
  tap.observeRemoteEnergy(0.01);
  tap.observeRemoteEnergy(0.01);
  await Promise.resolve();
  check('audio does not retrigger after the response stopped', stops === 1);

  speaking = true;
  at += 1_000;
  tap.observeRemoteEnergy(0.01);
  at += 700;
  tap.observeRemoteEnergy(0.01);
  await Promise.resolve();
  check('frames outside the speech window do not interrupt', stops === 1);

  at += 100;
  tap.observeRemoteEnergy(0.01);
  await Promise.resolve();
  check('a fresh consecutive pair interrupts the next response', stops === 2);

  speaking = true;
  const quietBase = createRemoteAudioActivityTap({ now: () => at });
  const quietTap = createBargeInRemoteAudioTap(quietBase, () => target, {
    minimumRms: 0.0002,
    now: () => at,
  });
  quietTap.ready();
  at += 100;
  quietTap.observeRemoteEnergy(0.0003);
  at += 100;
  quietTap.observeRemoteEnergy(0.0004);
  await Promise.resolve();
  check('configured Meet-level speech interrupts an active response', stops === 3);

  speaking = true;
  const productionBase = createRemoteAudioActivityTap({ now: () => at });
  const productionTap = createBargeInRemoteAudioTap(productionBase, () => target, { now: () => at });
  productionTap.ready();
  at += 100;
  productionTap.observeRemoteEnergy(0.0003);
  at += 100;
  productionTap.observeRemoteEnergy(0.0004);
  await Promise.resolve();
  check('production threshold ignores low-level meeting noise during playback', stops === 3);

  if (failures) process.exit(1);
  console.log('\n✅ barge-in: remote speech interrupts Wantok without reacting to isolated noise.');
}

void main();
