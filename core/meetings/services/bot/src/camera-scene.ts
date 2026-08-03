import type { BrowserContext, Page } from '@vexa/remote-browser';

export type CameraSceneMode = 'listening' | 'thinking' | 'speaking' | 'celebrating';

export interface CameraSceneItem {
  id: string;
  label: string;
  meta?: string;
  status?: 'proposed' | 'confirmed' | 'done';
}

export interface CameraSceneFocusItem extends CameraSceneItem {
  kind: 'blocker' | 'open_question';
}

export interface CameraSceneState {
  activity?: {
    at: string;
    kind: 'task_added' | 'decision_added' | 'blocker_added' | 'question_added' | 'research_started' | 'action_pending' | 'action_completed' | 'message_sent' | 'teammate_replied' | 'answering';
    label: string;
  };
  decisions: CameraSceneItem[];
  focus: CameraSceneFocusItem[];
  mode: CameraSceneMode;
  subtitle?: string;
  tasks: CameraSceneItem[];
  title: string;
}

export interface CameraSceneController {
  reset(): Promise<void>;
  setMode(mode: CameraSceneMode, subtitle?: string): Promise<void>;
  show(encodedState: string): Promise<void>;
  start(): Promise<void>;
}

const DEFAULT_SCENE: CameraSceneState = {
  decisions: [],
  focus: [],
  mode: 'listening',
  subtitle: 'Je suis la conversation et je garde le fil.',
  tasks: [],
  title: 'Wantok est avec vous',
};

const MAX_SCENE_BYTES = 64 * 1024;
const cameraOnSelectors = [
  'button[aria-label*="Turn on camera"]',
  'button[aria-label*="Enable camera"]',
  'button[aria-label*="Activer la caméra"]',
  'button[aria-label*="Démarrer la caméra"]',
  '[role="button"][aria-label*="turn on camera" i]',
  '[role="button"][aria-label*="enable camera" i]',
];
const cameraOffSelectors = [
  'button[aria-label*="Turn off camera"]',
  'button[aria-label*="Disable camera"]',
  'button[aria-label*="Désactiver la caméra"]',
  'button[aria-label*="Arrêter la caméra"]',
  '[role="button"][aria-label*="turn off camera" i]',
  '[role="button"][aria-label*="disable camera" i]',
];

export function cameraBrowserArgs(): string[] {
  // The canvas-backed camera is installed by getUserMedia interception below. Enabling
  // Chromium's fake media device would also replace PulseAudio's virtual microphone with
  // Chrome's synthetic test tone, making TTS inaudible to meeting participants.
  return [];
}

export async function installCameraScene(context: BrowserContext, platform: string): Promise<void> {
  if (platform !== 'google_meet') return;
  await context.addInitScript(CAMERA_INIT_SCRIPT);
}

export function createCameraSceneController(
  page: Page,
  platform: string,
  timeouts = { activationMs: 10_000, verificationMs: 5_000 },
): CameraSceneController {
  let current = structuredClone(DEFAULT_SCENE);

  const apply = async (state: CameraSceneState): Promise<void> => {
    current = normalizeCameraScene(state);
    await page.evaluate((next) => {
      const scene = (globalThis as any).__wantokCameraScene;
      scene?.setState?.(next);
    }, current);
  };

  return {
    async start(): Promise<void> {
      if (platform !== 'google_meet') return;
      await apply(current);
      if (await anyVisible(page, cameraOffSelectors)) {
        console.log('[bot] camera-scene: synthetic camera already enabled');
        return;
      }
      const button = await firstVisible(page, cameraOnSelectors, timeouts.activationMs);
      if (!button) {
        const controls = await visibleCameraControls(page);
        console.warn(`[bot] camera-scene: camera enable control was not found; controls=${JSON.stringify(controls)}`);
        await page.keyboard.press('Control+E');
        const enabled = await waitForVisible(page, cameraOffSelectors, timeouts.verificationMs);
        console.log(`[bot] camera-scene: synthetic camera shortcut ${enabled ? 'enabled' : 'requested'}`);
        return;
      }
      await button.click();
      const enabled = await waitForVisible(page, cameraOffSelectors, timeouts.verificationMs);
      console.log(`[bot] camera-scene: synthetic camera ${enabled ? 'enabled' : 'enable requested'}`);
    },

    async show(encodedState: string): Promise<void> {
      await apply(decodeCameraScene(encodedState));
    },

    async setMode(mode: CameraSceneMode, subtitle?: string): Promise<void> {
      await apply({ ...current, mode, ...(subtitle ? { subtitle } : {}) });
    },

    async reset(): Promise<void> {
      await apply(structuredClone(DEFAULT_SCENE));
    },
  };
}

export function encodeCameraScene(state: CameraSceneState): string {
  const encoded = Buffer.from(JSON.stringify(normalizeCameraScene(state)), 'utf8').toString('base64');
  return `data:application/json;base64,${encoded}`;
}

export function decodeCameraScene(value: string): CameraSceneState {
  const prefix = 'data:application/json;base64,';
  if (!value.startsWith(prefix)) throw new Error('Camera scene must use an inline JSON payload');
  const payload = Buffer.from(value.slice(prefix.length), 'base64');
  if (payload.byteLength === 0 || payload.byteLength > MAX_SCENE_BYTES) {
    throw new Error('Camera scene payload size is invalid');
  }
  return normalizeCameraScene(JSON.parse(payload.toString('utf8')) as unknown);
}

export function normalizeCameraScene(value: unknown): CameraSceneState {
  if (!value || typeof value !== 'object') throw new Error('Camera scene payload is invalid');
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  if (!['listening', 'thinking', 'speaking', 'celebrating'].includes(String(mode))) {
    throw new Error('Camera scene mode is invalid');
  }
  const title = boundedText(input.title, 120, 'Camera scene title');
  const subtitle = optionalText(input.subtitle, 220, 'Camera scene subtitle');
  const tasks = normalizeItems(input.tasks, 8);
  const decisions = normalizeItems(input.decisions, 4);
  const focus = normalizeFocusItems(input.focus, 4);
  const activity = normalizeActivity(input.activity);
  return {
    ...(activity ? { activity } : {}),
    decisions,
    focus,
    mode: mode as CameraSceneMode,
    ...(subtitle ? { subtitle } : {}),
    tasks,
    title,
  };
}

function normalizeFocusItems(value: unknown, limit: number): CameraSceneFocusItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-limit).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Camera scene focus item is invalid');
    const normalized = normalizeItems([item], 1)[0]!;
    const kind = String((item as Record<string, unknown>).kind);
    if (!['blocker', 'open_question'].includes(kind)) {
      throw new Error('Camera scene focus item kind is invalid');
    }
    return { ...normalized, kind: kind as CameraSceneFocusItem['kind'] };
  });
}

function normalizeItems(value: unknown, limit: number): CameraSceneItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-limit).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Camera scene item is invalid');
    const input = item as Record<string, unknown>;
    const status = input.status;
    if (status !== undefined && !['proposed', 'confirmed', 'done'].includes(String(status))) {
      throw new Error('Camera scene item status is invalid');
    }
    return {
      id: boundedText(input.id, 120, 'Camera scene item ID'),
      label: boundedText(input.label, 240, 'Camera scene item label'),
      ...(input.meta ? { meta: boundedText(input.meta, 120, 'Camera scene item metadata') } : {}),
      ...(status ? { status: status as CameraSceneItem['status'] } : {}),
    };
  });
}

function normalizeActivity(value: unknown): CameraSceneState['activity'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new Error('Camera scene activity is invalid');
  const input = value as Record<string, unknown>;
  const kind = String(input.kind);
  if (!['task_added', 'decision_added', 'blocker_added', 'question_added', 'research_started', 'action_pending', 'action_completed', 'message_sent', 'teammate_replied', 'answering'].includes(kind)) {
    throw new Error('Camera scene activity kind is invalid');
  }
  const at = boundedText(input.at, 40, 'Camera scene activity timestamp');
  if (!Number.isFinite(Date.parse(at))) throw new Error('Camera scene activity timestamp is invalid');
  return {
    at,
    kind: kind as NonNullable<CameraSceneState['activity']>['kind'],
    label: boundedText(input.label, 240, 'Camera scene activity label'),
  };
}

function boundedText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} is invalid`);
  return normalized;
}

function optionalText(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedText(value, maxLength, label);
}

async function firstVisible(page: Page, selectors: readonly string[], timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function waitForVisible(page: Page, selectors: readonly string[], timeoutMs: number): Promise<boolean> {
  return (await firstVisible(page, selectors, timeoutMs)) !== null;
}

async function visibleCameraControls(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(globalThis as any).document.querySelectorAll('[role="button"], button')]
    .filter((element: any) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((element: any) => element.getAttribute('aria-label') ?? element.getAttribute('data-tooltip') ?? '')
    .filter((label: string) => /camera|video/iu.test(label))
    .slice(0, 12))
    .catch(() => []);
}

const CAMERA_INIT_SCRIPT = String.raw`(() => {
  if (globalThis.__wantokCameraInstalled) return;
  globalThis.__wantokCameraInstalled = true;

  const mediaDevices = globalThis.navigator && globalThis.navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') return;
  const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  const nativeEnumerateDevices = typeof mediaDevices.enumerateDevices === 'function'
    ? mediaDevices.enumerateDevices.bind(mediaDevices)
    : null;
  const videoProfile = { width: 1280, height: 720, frameRate: 12, maxBitrate: 1800000 };
  const syntheticTracks = new WeakSet();
  const syntheticSenders = new Set();
  const senderTunePending = new WeakSet();
  const nativeTrackClone = globalThis.MediaStreamTrack && globalThis.MediaStreamTrack.prototype.clone;
  const nativeTrackApplyConstraints = globalThis.MediaStreamTrack && globalThis.MediaStreamTrack.prototype.applyConstraints;
  const nativeTrackGetCapabilities = globalThis.MediaStreamTrack && globalThis.MediaStreamTrack.prototype.getCapabilities;
  const nativeTrackGetConstraints = globalThis.MediaStreamTrack && globalThis.MediaStreamTrack.prototype.getConstraints;
  const nativeTrackGetSettings = globalThis.MediaStreamTrack && globalThis.MediaStreamTrack.prototype.getSettings;
  const nativeSenderSetParameters = globalThis.RTCRtpSender && globalThis.RTCRtpSender.prototype.setParameters;
  let baseTrack = null;
  let state = ${JSON.stringify(DEFAULT_SCENE)};
  let previousActivityAt = null;
  let activityStartedAt = 0;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const roundedRect = (ctx, x, y, width, height, radius) => {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, r);
  };
  const fitText = (ctx, text, maxWidth) => {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let output = text;
    while (output.length > 1 && ctx.measureText(output + '…').width > maxWidth) output = output.slice(0, -1);
    return output + '…';
  };

  const logVideoQuality = (event, details = {}) => {
    try {
      globalThis.logBot?.('camera-quality ' + JSON.stringify({ event, ...details }));
    } catch {}
  };

  const markSyntheticTrack = (track) => {
    if (!track) return track;
    syntheticTracks.add(track);
    try { track.contentHint = 'text'; } catch {}
    return track;
  };

  const applyVideoPolicy = (parameters) => {
    if (!parameters || typeof parameters !== 'object') return parameters;
    parameters.degradationPreference = 'maintain-resolution';
    const encodings = Array.isArray(parameters.encodings) ? parameters.encodings : [];
    const activeEncodings = encodings.filter((encoding) => encoding && encoding.active !== false);
    if (!activeEncodings.length) return parameters;
    const topEncoding = activeEncodings.reduce((best, encoding) => {
      const bestScale = Number(best.scaleResolutionDownBy) || 1;
      const scale = Number(encoding.scaleResolutionDownBy) || 1;
      return scale < bestScale ? encoding : best;
    });
    topEncoding.scaleResolutionDownBy = 1;
    topEncoding.maxFramerate = videoProfile.frameRate;
    topEncoding.maxBitrate = Math.max(Number(topEncoding.maxBitrate) || 0, videoProfile.maxBitrate);
    return parameters;
  };

  const reportSenderQuality = async (sender) => {
    if (!sender || !syntheticTracks.has(sender.track) || typeof sender.getStats !== 'function') return;
    try {
      const stats = await sender.getStats();
      for (const report of stats.values()) {
        if (report.type !== 'outbound-rtp' || report.kind !== 'video' || report.isRemote) continue;
        logVideoQuality('outbound', {
          frameWidth: report.frameWidth,
          frameHeight: report.frameHeight,
          framesPerSecond: report.framesPerSecond,
          qualityLimitationReason: report.qualityLimitationReason,
          targetBitrate: report.targetBitrate,
        });
      }
    } catch (error) {
      logVideoQuality('stats_failed', { message: String(error) });
    }
  };

  const tuneSender = async (sender) => {
    if (!sender || !syntheticTracks.has(sender.track) || senderTunePending.has(sender)) return;
    syntheticSenders.add(sender);
    senderTunePending.add(sender);
    try {
      const parameters = applyVideoPolicy(sender.getParameters());
      if (parameters.encodings && parameters.encodings.length) {
        await nativeSenderSetParameters.call(sender, parameters);
      }
      const settings = sender.track.getSettings?.() || {};
      logVideoQuality('sender_tuned', {
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        contentHint: sender.track.contentHint,
      });
    } catch (error) {
      logVideoQuality('sender_tune_failed', { message: String(error) });
    } finally {
      senderTunePending.delete(sender);
    }
  };

  if (nativeTrackClone) {
    globalThis.MediaStreamTrack.prototype.clone = function wantokCloneTrack() {
      const clone = nativeTrackClone.call(this);
      return syntheticTracks.has(this) ? markSyntheticTrack(clone) : clone;
    };
  }
  if (nativeTrackApplyConstraints) {
    globalThis.MediaStreamTrack.prototype.applyConstraints = function wantokApplyConstraints(constraints) {
      if (syntheticTracks.has(this)) {
        logVideoQuality('constraints_ignored', { requested: constraints || {} });
        return Promise.resolve();
      }
      return nativeTrackApplyConstraints.call(this, constraints);
    };
  }
  if (nativeTrackGetCapabilities) {
    globalThis.MediaStreamTrack.prototype.getCapabilities = function wantokGetCapabilities() {
      if (!syntheticTracks.has(this)) return nativeTrackGetCapabilities.call(this);
      return {
        aspectRatio: { min: 16 / 9, max: 16 / 9 },
        frameRate: { min: 1, max: videoProfile.frameRate },
        height: { min: videoProfile.height, max: videoProfile.height },
        resizeMode: ['none'],
        width: { min: videoProfile.width, max: videoProfile.width },
      };
    };
  }
  if (nativeTrackGetConstraints) {
    globalThis.MediaStreamTrack.prototype.getConstraints = function wantokGetConstraints() {
      if (!syntheticTracks.has(this)) return nativeTrackGetConstraints.call(this);
      return {
        aspectRatio: { exact: 16 / 9 },
        frameRate: { exact: videoProfile.frameRate },
        height: { exact: videoProfile.height },
        width: { exact: videoProfile.width },
      };
    };
  }
  if (nativeTrackGetSettings) {
    globalThis.MediaStreamTrack.prototype.getSettings = function wantokGetSettings() {
      if (!syntheticTracks.has(this)) return nativeTrackGetSettings.call(this);
      return {
        ...nativeTrackGetSettings.call(this),
        aspectRatio: 16 / 9,
        deviceId: 'wantok-camera',
        frameRate: videoProfile.frameRate,
        height: videoProfile.height,
        resizeMode: 'none',
        width: videoProfile.width,
      };
    };
  }
  if (nativeSenderSetParameters) {
    globalThis.RTCRtpSender.prototype.setParameters = function wantokSetParameters(parameters) {
      return nativeSenderSetParameters.call(
        this,
        syntheticTracks.has(this.track) ? applyVideoPolicy(parameters) : parameters,
      );
    };
  }
  if (globalThis.RTCPeerConnection) {
    const peerConnectionPrototype = globalThis.RTCPeerConnection.prototype;
    const nativeAddTrack = peerConnectionPrototype.addTrack;
    const nativeAddTransceiver = peerConnectionPrototype.addTransceiver;
    if (nativeAddTrack) {
      peerConnectionPrototype.addTrack = function wantokAddTrack(track, ...streams) {
        const sender = nativeAddTrack.call(this, track, ...streams);
        if (syntheticTracks.has(track)) queueMicrotask(() => tuneSender(sender));
        return sender;
      };
    }
    if (nativeAddTransceiver) {
      peerConnectionPrototype.addTransceiver = function wantokAddTransceiver(trackOrKind, init) {
        const transceiver = nativeAddTransceiver.call(this, trackOrKind, init);
        if (typeof trackOrKind !== 'string' && syntheticTracks.has(trackOrKind)) {
          queueMicrotask(() => tuneSender(transceiver.sender));
        }
        return transceiver;
      };
    }
  }

  globalThis.setInterval(() => {
    for (const sender of syntheticSenders) {
      void tuneSender(sender);
      void reportSenderQuality(sender);
    }
  }, 10000);

  const createTrack = () => {
    if (baseTrack && baseTrack.readyState === 'live') return baseTrack;
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = videoProfile.width;
    canvas.height = videoProfile.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    const startedAt = performance.now();
    let lastRenderedAt = -Infinity;

    const render = (now) => {
      globalThis.requestAnimationFrame(render);
      if (now - lastRenderedAt < 1000 / 12) return;
      lastRenderedAt = now;
      const width = 1280;
      const height = 720;
      const t = (now - startedAt) / 1000;
      const pulseSpeed = state.mode === 'thinking' ? 3.2 : state.mode === 'speaking' ? 5.5 : 1.35;
      const pulse = (Math.sin(t * pulseSpeed) + 1) / 2;

      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#0b1424');
      gradient.addColorStop(0.58, '#101b30');
      gradient.addColorStop(1, '#192238');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = '#99a7be';
      ctx.lineWidth = 1;
      for (let x = 40; x < width; x += 56) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 40; y < height; y += 56) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      ctx.fillStyle = '#f7f5ef';
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.fillText('WANTOK', 104, 66);
      ctx.fillStyle = '#8490a5';
      ctx.font = '600 16px system-ui, sans-serif';
      ctx.fillText('AI TEAMMATE  /  LIVE', 104, 94);

      const centerX = 252;
      const centerY = 307;
      const halo = 96 + pulse * 22;
      const haloGradient = ctx.createRadialGradient(centerX, centerY, 22, centerX, centerY, halo);
      haloGradient.addColorStop(0, 'rgba(240,88,36,0.72)');
      haloGradient.addColorStop(0.45, 'rgba(240,88,36,0.22)');
      haloGradient.addColorStop(1, 'rgba(240,88,36,0)');
      ctx.fillStyle = haloGradient;
      ctx.beginPath(); ctx.arc(centerX, centerY, halo, 0, Math.PI * 2); ctx.fill();

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(-0.08 + Math.sin(t * 0.7) * 0.025);
      ctx.fillStyle = '#f05824';
      ctx.beginPath();
      const points = 80;
      for (let i = 0; i <= points; i += 1) {
        const angle = (i / points) * Math.PI * 2;
        const radius = 70 + Math.sin(angle * 3 + t * 1.2) * 6 + Math.sin(angle * 5 - t * 0.8) * 4 + pulse * 3;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fffaf5';
      ctx.font = '800 76px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('W', 0, 3);
      ctx.restore();

      const statusLabels = { listening: 'À L’ÉCOUTE', thinking: 'JE RÉFLÉCHIS', speaking: 'JE RÉPONDS', celebrating: 'C’EST NOTÉ' };
      ctx.fillStyle = '#f7f5ef';
      ctx.font = '750 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(statusLabels[state.mode] || statusLabels.listening, centerX, 438);
      ctx.fillStyle = '#8995a9';
      ctx.font = '500 17px system-ui, sans-serif';
      ctx.fillText('one talk.', centerX, 470);

      const waveY = 534;
      const waveAmplitude = state.mode === 'speaking' ? 28 : state.mode === 'thinking' ? 18 : 9;
      ctx.strokeStyle = '#f05824';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 15; i += 1) {
        const x = 122 + i * 18;
        const amplitude = 5 + Math.abs(Math.sin(t * pulseSpeed + i * 0.65)) * waveAmplitude;
        ctx.moveTo(x, waveY - amplitude / 2); ctx.lineTo(x, waveY + amplitude / 2);
      }
      ctx.stroke();

      const panelX = 430;
      const panelY = 62;
      const panelW = 720;
      const panelH = 596;
      roundedRect(ctx, panelX, panelY, panelW, panelH, 30);
      ctx.fillStyle = 'rgba(247,245,239,0.96)';
      ctx.fill();

      ctx.textAlign = 'left';
      ctx.fillStyle = '#f05824';
      ctx.font = '750 15px system-ui, sans-serif';
      ctx.fillText(state.tasks.length ? 'SUIVI EN DIRECT' : 'PRÉSENT DANS LA RÉUNION', panelX + 38, panelY + 48);
      ctx.fillStyle = '#0e1728';
      ctx.font = '750 34px system-ui, sans-serif';
      ctx.fillText(fitText(ctx, state.title || 'Wantok est avec vous', panelW - 76), panelX + 38, panelY + 92);
      ctx.fillStyle = '#667085';
      ctx.font = '500 18px system-ui, sans-serif';
      ctx.fillText(fitText(ctx, state.subtitle || 'Je suis la conversation et je garde le fil.', panelW - 76), panelX + 38, panelY + 126);

      const activityAt = state.activity && state.activity.at;
      if (activityAt && activityAt !== previousActivityAt) {
        previousActivityAt = activityAt;
        activityStartedAt = now;
      }
      const activityProgress = clamp((now - activityStartedAt) / 700, 0, 1);
      const eased = 1 - Math.pow(1 - activityProgress, 3);

      let rowY = panelY + 170;
      const decision = (state.decisions || []).slice(-1)[0];
      const focusItem = (state.focus || []).slice(-1)[0];
      const taskLimit = decision && focusItem ? 2 : decision || focusItem ? 3 : 5;
      const allTasks = state.tasks || [];
      const visibleTasks = allTasks.slice(-taskLimit);
      if (!visibleTasks.length && !decision && !focusItem) {
        roundedRect(ctx, panelX + 38, rowY, panelW - 76, 126, 20);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = '#e7e3dc'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#0e1728';
        ctx.font = '700 22px system-ui, sans-serif';
        ctx.fillText('Je transforme les échanges en avancées.', panelX + 66, rowY + 50);
        ctx.fillStyle = '#667085';
        ctx.font = '500 17px system-ui, sans-serif';
        ctx.fillText('Tâches, décisions et questions restent visibles ici.', panelX + 66, rowY + 84);
        rowY += 148;
      } else {
        ctx.fillStyle = '#667085';
        ctx.font = '700 14px system-ui, sans-serif';
        const hiddenTaskCount = Math.max(0, allTasks.length - visibleTasks.length);
        ctx.fillText(hiddenTaskCount ? 'TÂCHES  ·  +' + hiddenTaskCount + ' DANS LE DASHBOARD' : 'TÂCHES', panelX + 38, rowY);
        rowY += 20;
        visibleTasks.forEach((task, index) => {
          const isNewest = index === visibleTasks.length - 1 && state.activity && state.activity.kind === 'task_added';
          const offset = isNewest ? (1 - eased) * 44 : 0;
          const opacity = isNewest ? 0.25 + eased * 0.75 : 1;
          ctx.save(); ctx.globalAlpha = opacity;
          roundedRect(ctx, panelX + 38 + offset, rowY, panelW - 76 - offset, 66, 15);
          ctx.fillStyle = isNewest && activityProgress < 1 ? '#fff0e9' : '#fff'; ctx.fill();
          ctx.strokeStyle = isNewest ? '#f5a385' : '#e7e3dc'; ctx.lineWidth = 2; ctx.stroke();
          ctx.strokeStyle = task.status === 'done' ? '#2f8f5b' : '#f05824';
          ctx.lineWidth = 3; ctx.strokeRect(panelX + 58 + offset, rowY + 22, 20, 20);
          if (task.status === 'done') {
            ctx.beginPath(); ctx.moveTo(panelX + 62 + offset, rowY + 32); ctx.lineTo(panelX + 68 + offset, rowY + 38); ctx.lineTo(panelX + 76 + offset, rowY + 26); ctx.stroke();
          }
          ctx.fillStyle = '#0e1728'; ctx.font = '650 18px system-ui, sans-serif';
          ctx.fillText(fitText(ctx, task.label, panelW - 180), panelX + 94 + offset, rowY + 30);
          if (task.meta) {
            ctx.fillStyle = '#7a8496'; ctx.font = '500 14px system-ui, sans-serif';
            ctx.fillText(fitText(ctx, task.meta, panelW - 180), panelX + 94 + offset, rowY + 51);
          }
          ctx.restore();
          rowY += 76;
        });
      }

      if (decision && rowY < panelY + panelH - 80) {
        ctx.fillStyle = '#667085'; ctx.font = '700 14px system-ui, sans-serif';
        ctx.fillText('DERNIÈRE DÉCISION', panelX + 38, rowY + 6);
        rowY += 22;
        roundedRect(ctx, panelX + 38, rowY, panelW - 76, 70, 15);
        ctx.fillStyle = '#17243b'; ctx.fill();
        ctx.fillStyle = '#ffb39a'; ctx.font = '750 16px system-ui, sans-serif'; ctx.fillText('✓', panelX + 60, rowY + 29);
        ctx.fillStyle = '#f7f5ef'; ctx.font = '600 17px system-ui, sans-serif';
        ctx.fillText(fitText(ctx, decision.label, panelW - 145), panelX + 88, rowY + 29);
        if (decision.meta) {
          ctx.fillStyle = '#aab3c2'; ctx.font = '500 13px system-ui, sans-serif';
          ctx.fillText(fitText(ctx, decision.meta, panelW - 145), panelX + 88, rowY + 51);
        }
        rowY += 82;
      }

      if (focusItem && rowY < panelY + panelH - 70) {
        const isBlocker = focusItem.kind === 'blocker';
        ctx.fillStyle = '#667085'; ctx.font = '700 14px system-ui, sans-serif';
        ctx.fillText(isBlocker ? 'POINT DE BLOCAGE' : 'QUESTION OUVERTE', panelX + 38, rowY + 6);
        rowY += 22;
        roundedRect(ctx, panelX + 38, rowY, panelW - 76, 62, 15);
        ctx.fillStyle = isBlocker ? '#fff0e9' : '#eef4ff'; ctx.fill();
        ctx.strokeStyle = isBlocker ? '#f5a385' : '#9eb7e8'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = isBlocker ? '#d84918' : '#315f9f';
        ctx.font = '800 18px system-ui, sans-serif';
        ctx.fillText(isBlocker ? '!' : '?', panelX + 60, rowY + 37);
        ctx.fillStyle = '#0e1728'; ctx.font = '650 17px system-ui, sans-serif';
        ctx.fillText(fitText(ctx, focusItem.label, panelW - 150), panelX + 90, rowY + 28);
        if (focusItem.meta) {
          ctx.fillStyle = '#7a8496'; ctx.font = '500 13px system-ui, sans-serif';
          ctx.fillText(fitText(ctx, focusItem.meta, panelW - 150), panelX + 90, rowY + 48);
        }
      }

      if (state.activity && now - activityStartedAt < 4200) {
        const toastWidth = 470;
        const toastX = width - toastWidth - 46;
        const toastY = 26 + (1 - clamp((now - activityStartedAt) / 450, 0, 1)) * -38;
        roundedRect(ctx, toastX, toastY, toastWidth, 64, 18);
        ctx.fillStyle = '#f05824'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '750 16px system-ui, sans-serif';
        const activityLabels = { task_added: 'NOUVELLE TÂCHE', decision_added: 'DÉCISION CAPTURÉE', blocker_added: 'BLOCAGE DÉTECTÉ', question_added: 'QUESTION OUVERTE', research_started: 'RECHERCHE EN COURS', action_pending: 'CONFIRMATION REQUISE', action_completed: 'ACTION TERMINÉE', message_sent: 'MESSAGE ENVOYÉ', teammate_replied: 'RÉPONSE REÇUE', answering: 'RÉPONSE EN COURS' };
        ctx.fillText(activityLabels[state.activity.kind] || 'MISE À JOUR', toastX + 22, toastY + 25);
        ctx.font = '550 14px system-ui, sans-serif';
        ctx.fillText(fitText(ctx, state.activity.label, toastWidth - 44), toastX + 22, toastY + 47);
      }

    };
    globalThis.requestAnimationFrame(render);
    const stream = canvas.captureStream(videoProfile.frameRate);
    baseTrack = markSyntheticTrack(stream.getVideoTracks()[0]);
    logVideoQuality('source_created', baseTrack.getSettings?.() || {});
    return baseTrack;
  };

  mediaDevices.getUserMedia = async function wantokGetUserMedia(constraints) {
    if (!constraints || !constraints.video) return nativeGetUserMedia(constraints);
    const tracks = [];
    if (constraints.audio) {
      const audioStream = await nativeGetUserMedia({ audio: constraints.audio, video: false });
      tracks.push(...audioStream.getAudioTracks());
    }
    const videoTrack = markSyntheticTrack(createTrack().clone());
    tracks.push(videoTrack);
    return new MediaStream(tracks);
  };

  if (nativeEnumerateDevices) {
    mediaDevices.enumerateDevices = async function wantokEnumerateDevices() {
      const devices = await nativeEnumerateDevices();
      if (devices.some((device) => device.kind === 'videoinput')) return devices;
      return [...devices, {
        deviceId: 'wantok-camera',
        groupId: 'wantok-virtual-media',
        kind: 'videoinput',
        label: 'Wantok animated camera',
        toJSON() { return this; },
      }];
    };
  }

  globalThis.__wantokCameraScene = {
    setState(next) {
      if (!next || typeof next !== 'object') return;
      state = next;
    },
  };
})();`;
