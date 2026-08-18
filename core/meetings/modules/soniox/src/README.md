# Soniox adapter source

`soniox-client.ts` owns the provider WebSocket protocol, PCM conversion, result
normalization, retry policy, and typed failure translation. `index.ts` is the
only published package front door. The adjacent test uses an in-memory socket;
it never contacts Soniox.
