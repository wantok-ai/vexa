import type { BrowserContext, Page } from '@vexa/remote-browser';

export interface StageController {
  show(url: string): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

const presentButtonSelectors = [
  'button[aria-label*="Present now"]',
  'button[aria-label*="Share screen"]',
  'button:has-text("Present now")',
];

const tabShareSelectors = [
  '[role="menuitem"]:has-text("A tab")',
  '[role="menuitem"]:has-text("Chrome tab")',
  'li:has-text("A tab")',
];

const stopSelectors = [
  'button[aria-label*="Stop presenting"]',
  'button:has-text("Stop presenting")',
];

export function createStageController(
  meetingPage: Page,
  context: BrowserContext,
  platform: string,
): StageController {
  let stagePage: Page | null = null;
  let sharing = false;

  return {
    async show(value: string): Promise<void> {
      if (platform !== 'google_meet') throw new Error('Public stage is only enabled for Google Meet');
      const url = validateStageUrl(value);
      if (!stagePage || stagePage.isClosed()) stagePage = await context.newPage();
      await renderStage(stagePage, url);
      if (sharing) return;

      await clickFirstVisible(meetingPage, presentButtonSelectors, 8_000);
      await clickFirstVisible(meetingPage, tabShareSelectors, 5_000);
      await meetingPage.locator(stopSelectors.join(',')).first().waitFor({ state: 'visible', timeout: 10_000 });
      sharing = true;
    },

    async stop(): Promise<void> {
      if (sharing) {
        await clickFirstVisible(meetingPage, stopSelectors, 5_000).catch(() => undefined);
      }
      sharing = false;
      await stagePage?.close().catch(() => undefined);
      stagePage = null;
    },

    async close(): Promise<void> {
      await this.stop();
    },
  };
}

export function stageCaptureBrowserArgs(): string[] {
  return [
    '--auto-select-desktop-capture-source=Wantok Scene',
    '--auto-select-tab-capture-source-by-title=Wantok Scene',
  ];
}

async function renderStage(page: Page, url: URL): Promise<void> {
  const source = escapeAttribute(url.toString());
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Wantok Scene</title>
        <style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#0e1728}</style>
      </head>
      <body><iframe src="${source}" allow="autoplay; fullscreen"></iframe></body>
    </html>`);
  await page.bringToFront();
}

async function clickFirstVisible(page: Page, selectors: readonly string[], timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click();
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Stage control was not found: ${selectors.join(' | ')}`);
}

function validateStageUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Stage URL must use HTTPS');
  if (url.username || url.password) throw new Error('Stage URL credentials are forbidden');
  if (isPrivateHostname(url.hostname)) throw new Error('Private stage hosts are forbidden');
  return url;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
