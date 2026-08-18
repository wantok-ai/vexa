import type { RemoteAudioActivityTap } from './aloneness.js';

export interface BargeInTarget {
  isSpeaking(): boolean;
  stop(): Promise<void>;
}

export interface BargeInOptions {
  consecutiveFrames?: number;
  frameWindowMs?: number;
  minimumRms?: number;
  now?: () => number;
  onInterrupt?: () => void;
}

/**
 * Decorate the remote-audio presence tap with a conservative barge-in detector.
 * Two speech-level frames close together are required so isolated clicks and Meet UI
 * sounds do not interrupt Wantok. The capture bridge only feeds remote tracks here;
 * Wantok's own virtual microphone never enters this path.
 */
export function createBargeInRemoteAudioTap(
  activity: RemoteAudioActivityTap,
  target: () => BargeInTarget | null,
  options: BargeInOptions = {},
): RemoteAudioActivityTap {
  const consecutiveFrames = options.consecutiveFrames ?? 2;
  const frameWindowMs = options.frameWindowMs ?? 600;
  const minimumRms = options.minimumRms ?? 0.0025;
  const now = options.now ?? Date.now;
  let qualifyingFrames = 0;
  let lastQualifyingAt = 0;
  let interrupting = false;

  return {
    ready(): void {
      qualifyingFrames = 0;
      activity.ready();
    },
    observeRemoteEnergy(energy: number): void {
      activity.observeRemoteEnergy(energy);
      const current = target();
      if (!current?.isSpeaking() || !Number.isFinite(energy) || energy < minimumRms) {
        qualifyingFrames = 0;
        return;
      }
      const at = now();
      qualifyingFrames = at - lastQualifyingAt <= frameWindowMs ? qualifyingFrames + 1 : 1;
      lastQualifyingAt = at;
      if (qualifyingFrames < consecutiveFrames || interrupting) return;

      qualifyingFrames = 0;
      interrupting = true;
      options.onInterrupt?.();
      void current.stop()
        .catch((error) => console.error(`[bot] barge-in: stop failed: ${String(error)}`))
        .finally(() => {
          interrupting = false;
        });
    },
    unavailable(): void {
      qualifyingFrames = 0;
      activity.unavailable();
    },
    snapshot() {
      return activity.snapshot();
    },
  };
}
