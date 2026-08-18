import { BOT_OWNED_BROWSER_SIGNALS } from './browser.js';

let failed = 0;
const check = (name: string, condition: boolean) => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}`);
  if (!condition) failed++;
};

check('Playwright does not close Chromium before the bot handles SIGTERM', BOT_OWNED_BROWSER_SIGNALS.handleSIGTERM === false);
check('Playwright does not close Chromium before the bot handles SIGINT', BOT_OWNED_BROWSER_SIGNALS.handleSIGINT === false);
check('Playwright does not close Chromium before the bot handles SIGHUP', BOT_OWNED_BROWSER_SIGNALS.handleSIGHUP === false);

if (failed) process.exit(1);
console.log('\n✅ browser signals: the bot exclusively owns graceful browser shutdown.');
