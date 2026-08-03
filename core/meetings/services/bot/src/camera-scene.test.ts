import {
  createCameraSceneController,
  cameraBrowserArgs,
  decodeCameraScene,
  encodeCameraScene,
  installCameraScene,
  type CameraSceneState,
} from './camera-scene.js';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

const scene: CameraSceneState = {
  activity: {
    at: '2026-08-02T14:00:00.000Z',
    kind: 'task_added',
    label: 'Send the proposal',
  },
  decisions: [{ id: 'decision-1', label: 'Ship Google Meet first' }],
  focus: [{ id: 'focus-1', kind: 'blocker', label: 'Waiting for legal approval' }],
  mode: 'celebrating',
  subtitle: 'One explicit commitment captured.',
  tasks: [{ id: 'task-1', label: 'Send the proposal', meta: 'Matthieu', status: 'proposed' }],
  title: 'Meeting momentum',
};

const encoded = encodeCameraScene(scene);
check('encodes as an inline JSON data URL', encoded.startsWith('data:application/json;base64,'));
const decoded = decodeCameraScene(encoded);
check('round-trips a normalized camera scene', decoded.title === scene.title && decoded.tasks[0]?.id === scene.tasks[0]?.id);
const teammateReply = decodeCameraScene(encodeCameraScene({
  ...scene,
  activity: { at: '2026-08-02T14:01:00.000Z', kind: 'teammate_replied', label: 'Legal approved the launch.' },
}));
check('accepts an absent teammate reply activity', teammateReply.activity?.kind === 'teammate_replied');

try {
  decodeCameraScene('https://example.com/scene.json');
  check('rejects remote avatar payloads', false);
} catch {
  check('rejects remote avatar payloads', true);
}

let initScript = '';
await installCameraScene({
  addInitScript: async (script: string) => { initScript = script; },
} as any, 'google_meet');
check('renders at Meet camera native 720p without resampling', initScript.includes('width: 1280') && initScript.includes('height: 720') && !initScript.includes('ctx.setTransform'));
check('prioritizes text resolution over motion', initScript.includes("contentHint = 'text'") && initScript.includes("degradationPreference = 'maintain-resolution'"));
check('prevents Meet from constraining the synthetic source to 360p', initScript.includes('wantokApplyConstraints') && initScript.includes('constraints_ignored'));
check('keeps a full-resolution outbound encoding', initScript.includes('topEncoding.scaleResolutionDownBy = 1'));
check('reports the outbound WebRTC resolution', initScript.includes("logVideoQuality('outbound'"));
check('intercepts video getUserMedia only', initScript.includes('if (!constraints || !constraints.video)'));
check('renders blockers and open questions in the shared scene', initScript.includes('POINT DE BLOCAGE'));
check('advertises a synthetic camera when Meet enumerates devices', initScript.includes('wantokEnumerateDevices'));
check(
  'keeps Chromium fake audio disabled so TTS uses PulseAudio',
  !cameraBrowserArgs().includes('--use-fake-device-for-media-stream'),
);

let cameraButtonClicks = 0;
let appliedState: CameraSceneState | null = null;
const page = {
  evaluate: async (_callback: unknown, value: CameraSceneState) => { appliedState = value; },
  keyboard: { press: async () => {} },
  locator: (selector: string) => ({
    first: () => ({
      click: async () => { cameraButtonClicks += 1; },
      isVisible: async () => selector.includes('Turn on camera'),
    }),
  }),
};
const controller = createCameraSceneController(page as any, 'google_meet');
await controller.start();
check('enables the Meet camera once', cameraButtonClicks === 1);
check('applies the default scene before enabling video', appliedState?.mode === 'listening');
await controller.show(encoded);
check('applies a remote task scene', appliedState?.tasks[0]?.label === 'Send the proposal');
check('applies a remote focus item', appliedState?.focus[0]?.kind === 'blocker');

let shortcutPresses = 0;
const shortcutPage = {
  evaluate: async () => [],
  keyboard: { press: async (shortcut: string) => { if (shortcut === 'Control+E') shortcutPresses += 1; } },
  locator: () => ({ first: () => ({ isVisible: async () => false }) }),
};
await createCameraSceneController(shortcutPage as any, 'google_meet', { activationMs: 0, verificationMs: 0 }).start();
check('falls back to the locale-independent Meet camera shortcut', shortcutPresses === 1);

if (failures > 0) process.exit(1);
console.log('✅ camera-scene: safe payloads, synthetic media, and Meet activation are wired.');
