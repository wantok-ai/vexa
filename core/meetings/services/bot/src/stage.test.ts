import { stageCaptureBrowserArgs } from './stage.js';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

const args = stageCaptureBrowserArgs();
check('selects the Wantok Scene desktop source', args.includes('--auto-select-desktop-capture-source=Wantok Scene'));
check('selects the Wantok Scene tab source', args.includes('--auto-select-tab-capture-source-by-title=Wantok Scene'));
check('does not weaken browser security', !args.some((arg) => arg.includes('disable-web-security')));

if (failures > 0) process.exit(1);
console.log('✅ stage: capture selection is explicit and does not weaken browser security.');
