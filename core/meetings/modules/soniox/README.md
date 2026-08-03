# @vexa/transcribe-soniox — Soniox STT egress

_meetings/ · module · the anti-corruption boundary to Soniox real-time STT._

One concern: take a 16 kHz Float32 PCM window, stream it as signed 16-bit PCM
over the Soniox WebSocket API, and normalize Soniox tokens and faults into the
STT result consumed by the meeting lanes. Speaker identity remains owned by the
capture lanes; this adapter never diarizes or renames speakers.

- Sends the Soniox configuration first, followed by ordered binary audio frames.
- Sends organization vocabulary through `context.terms` and the latest confirmed transcript tail
  through `context.text` so uncommon names and sentence continuity influence every short stream.
- Ends each bounded stream with an empty frame and waits for `finished: true`.
- Combines final tokens and the current non-final tail without duplicating text.
- Translates provider failures into typed, attributable STT faults.

## Surface

`SonioxTranscriptionClient` · `SonioxTranscriptionError` · normalized
`TranscriptionWord/Segment/Result` types. Front door: [`src/index.ts`](src/index.ts).

## Verify

```bash
pnpm --filter @vexa/transcribe-soniox build
pnpm --filter @vexa/transcribe-soniox test
```

The unit test uses an in-memory WebSocket adapter. A real provider call belongs
to the live transcription and meeting witness legs.
