import { agentToolUrlFromLifecycle, createHttpAgentToolSink } from './agent-tool-http.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failed += 1;
};

const meetingId = '00000000-0000-4000-8000-000000000001';
const callbackUrl = `http://wantok-supervisor:8090/lifecycle/${meetingId}`;
check(
  'maps the scoped lifecycle callback to the scoped tool endpoint',
  agentToolUrlFromLifecycle(callbackUrl) === `http://wantok-supervisor:8090/agent-tool/${meetingId}`,
);

let capturedUrl = '';
let capturedHeaders: Record<string, string> = {};
let capturedBody: Record<string, unknown> = {};
const sink = createHttpAgentToolSink({
  callbackUrl,
  internalSecret: 'secret',
  fetchImpl: async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body) as Record<string, unknown>;
    return { json: async () => ({ status: 'captured' }), ok: true, status: 202 };
  },
});
const result = await sink.execute({
  arguments: { kind: 'task', label: 'Prepare the launch' },
  callId: 'call-1',
  name: 'capture_meeting_memory',
});
check('posts tool calls to the supervisor', capturedUrl.endsWith(`/agent-tool/${meetingId}`));
check('authenticates without putting the secret in the payload', capturedHeaders['x-internal-secret'] === 'secret' && !JSON.stringify(capturedBody).includes('secret'));
check('preserves the provider call id for idempotency', capturedBody.call_id === 'call-1');
check('returns the supervisor result to the realtime model', result.status === 'captured');

if (failed) {
  console.error(`\n❌ agent-tool HTTP adapter: ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\n✅ agent-tool HTTP adapter: scoped, authenticated, and idempotent payload checks pass.');
