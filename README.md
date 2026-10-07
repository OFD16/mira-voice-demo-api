# Mira Voice Demo — API & Voice Agent

Backend for **Mira**, a full-duplex voice companion for wellbeing conversations (Turkish & English).
📱 Mobile app + **downloadable APK**: **[OFD16/mira-voice-demo-app](https://github.com/OFD16/mira-voice-demo-app/releases/latest)**

```
React Native app ──POST /session {userId, lang}──► this API (Express) ── signs a 15-min LiveKit token
        │
        └──── WebRTC / Opus ────► LiveKit Cloud (SFU) ◄────► Agent worker (this repo, src/agent.ts)
                                                               │
   Silero VAD + turn detector ─► Deepgram STT (tr/en) ─► Safety (keyword → classifier, fail-closed)
                                                               │      └─ risk → fixed crisis reply, LLM skipped
   pgvector memory (RAG) ─► Gemini 3.5 Flash-Lite (persona v2) ─► Cartesia TTS (streaming)
                                                               │
                      background: fact extractor ─► pgvector (dated, de-duplicated, corrections replace)
                      data channel "mira.events" ─► app: transcript, per-turn latency, safety, memory
```

## Highlights
- **Latency budget per turn** (EOU + LLM TTFT + TTS TTFB) streamed to the app as p50/p95.
- **Fail-closed safety** before every LLM call: deterministic keywords + timed classifier; on risk a fixed,
  human-reviewed crisis message is spoken and the LLM is skipped for that turn.
- **Long-term memory off the hot path**: a small background call extracts facts after each safe turn,
  converts relative dates ("on Friday") to absolute ones, skips duplicates and replaces corrected facts.
  Per-user isolation (`WHERE user_id = $1`), viewable and deletable from the app.
- **Languages**: device language → allowlisted `lang` → STT, TTS, persona, crisis reply and greeting.
- **Cost visibility**: per-call usage and estimated USD by provider in the logs (`src/usage.ts`).
- **Public-demo guards**: 10-min call cap, hang-up after 60 s of silence, 5 sessions/min per IP,
  global daily session cap, short-lived least-privilege tokens; the LiveKit secret never leaves the server.
- Tests for every critical rule (`npm test`).

## Run locally
```bash
npm i
cp .env.example .env        # fill keys (Gemini via OPENAI_BASE_URL, see the file)
npm run download-files      # VAD + turn detector models
docker compose up -d        # Postgres + pgvector (memory)
npm run dev:api             # :3000
npm run dev:agent           # agent worker → talk from LiveKit Cloud → Agents → Console, or the app
npm test
```

## Deploy (Dokploy / any Docker host)
One Dockerfile, two targets: **api** (behind your domain, port 3000) and **agent** (outbound only, no port).
Postgres must have pgvector: image `pgvector/pgvector:pg18` (match your major version).

**Dokploy, two Applications** from this repo (Build Type: Dockerfile):
| App | Docker Build Stage | Domain | Env |
|---|---|---|---|
| api | `api` | your domain → port 3000, HTTPS | `.env.example` keys, `DATABASE_URL` (internal), `TRUST_PROXY=1` |
| agent | `agent` | none | same keys |

Then check `https://<your-domain>/health`. Alternative: Dokploy **Compose** with `docker-compose.prod.yml` (api + agent + db).

API and agent are separate on purpose: the API serves short requests, the agent is long-lived and CPU-heavy
(VAD + turn detection), so they scale differently.

MIT · built by [Ömer Faruk Demirsoy](https://www.linkedin.com/in/omerfarukdemirsoy)
