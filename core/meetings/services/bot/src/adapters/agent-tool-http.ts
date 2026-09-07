import type { RealtimeToolCall } from '../realtime-voice.js';

export type AgentToolFetch = (
  url: string,
  init: { body: string; headers: Record<string, string>; method: string; signal: AbortSignal },
) => Promise<{ json(): Promise<unknown>; ok: boolean; status: number }>;

export interface AgentToolSink {
  execute(call: RealtimeToolCall): Promise<Record<string, unknown>>;
}

interface AgentToolSinkOptions {
  callbackUrl: string;
  fetchImpl?: AgentToolFetch;
  internalSecret?: string;
  timeoutMs?: number;
}

export function createHttpAgentToolSink(options: AgentToolSinkOptions): AgentToolSink {
  const endpoint = agentToolUrlFromLifecycle(options.callbackUrl);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as AgentToolFetch);
  const timeoutMs = options.timeoutMs ?? 900;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.internalSecret) headers['x-internal-secret'] = options.internalSecret;

  return {
    async execute(call): Promise<Record<string, unknown>> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      try {
        const response = await fetchImpl(endpoint, {
          body: JSON.stringify({
            arguments: call.arguments,
            call_id: call.callId,
            name: call.name,
          }),
          headers,
          method: 'POST',
          signal: controller.signal,
        });
        if (!response.ok) return { status: response.status === 409 ? 'duplicate' : 'unavailable' };
        const body = await response.json().catch(() => null);
        return body && typeof body === 'object' && !Array.isArray(body)
          ? body as Record<string, unknown>
          : { status: 'queued' };
      } catch {
        return { status: 'unavailable' };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function agentToolUrlFromLifecycle(callbackUrl: string): string {
  const url = new URL(callbackUrl);
  const match = url.pathname.match(/^(.*)\/lifecycle\/([a-f0-9-]{36})\/?$/i);
  if (!match) throw new Error('Lifecycle callback URL cannot be mapped to an agent-tool endpoint');
  url.pathname = `${match[1] ?? ''}/agent-tool/${match[2]}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
