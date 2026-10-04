# Mira Voice Demo — API & Voice Agent

Backend for **Mira**, a full-duplex voice companion for wellbeing conversations.
📱 Mobile app (React Native): **[OFD16/mira-voice-demo-app](https://github.com/OFD16/mira-voice-demo-app)**

```
React Native app ──POST /session──► this API (Express) ── signs a 15-min LiveKit token
        │                                                     
        └──── WebRTC / Opus ────► LiveKit Cloud (SFU) ◄────► Agent worker (this repo, src/agent.ts)
                                                               │
     Silero VAD + end-of-turn model ─► Deepgram STT (streaming) ─► Safety (keyword → classifier, fail-closed)
                                                               │            └─ risk → fixed crisis reply, LLM skipped
                pgvector memory (RAG) ─► GPT-4o-mini (persona + remember tool) ─► Cartesia TTS (streaming)
                                                               │
                              data channel "mira.events" ─► app: transcript, per-turn latency, safety, memory
```

**Two pipelines, switchable from the app:** `cascaded` (STT → LLM → TTS, every step inspectable) and `realtime` (OpenAI speech-to-speech).

## Features
- Per-turn latency budget (EOU + LLM TTFT + TTS TTFB) streamed to the app, p50/p95.
- Barge-in with false-interruption filtering; transcript keeps only the spoken part (`interrupted`).
- Fail-closed safety layer before every LLM call (deterministic keywords + timed classifier).
- Long-term memory in Postgres/pgvector, scoped per user, viewable and deletable from the app.
- Short-lived, least-privilege LiveKit tokens; the API secret never leaves the server.
- Tests for every critical rule (`npm test`).

## Run
```bash
npm i
cp .env.example .env        # fill keys
npm run download-files      # VAD + turn detector models
docker compose up -d        # optional: memory (pgvector)
npm run dev:api             # :3000
npm run dev:agent           # agent worker
npm test
```

## Branches
- `main` is a **learning version** with guided `TODO(Lx-yy)` exercises (see [docs/LESSONS.md](docs/LESSONS.md), Turkish).
- `solution` is the complete, production-ready implementation.

MIT · built by [Ömer Faruk Demirsoy](https://www.linkedin.com/in/omerfarukdemirsoy)
