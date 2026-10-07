// Mira voice agent worker. Joins every room created by POST /session.
//   npm run dev:agent      (connects to LiveKit Cloud and waits for rooms)
//   then talk from LiveKit Cloud → Agents → Console (browser), or from the mobile app.
//   (`npm run console` needs the LiveKit CLI broker since agents-js 1.9: `lk agent console`.)
import 'dotenv/config';
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  metrics,
  voice,
} from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { type MiraEvent, publishEvent } from './events.js';
import { LatencyTracker } from './latency.js';
import { type KnownFact, Memory, type MemoryRow, extractFacts, todayLabel } from './memory.js';
import { DEFAULT_LANG, LANG_PROFILE, type Lang, isLang } from './languages.js';
import { greeting, persona } from './persona.js';
import { checkSafety } from './safety.js';
import type { ParticipantMeta, Pipeline } from './session.js';
import { summarize } from './usage.js';

type Emit = (ev: MiraEvent) => void;

// A public APK means anyone can start a call: cap how long one can run.
const MAX_CALL_MS = Number(process.env.MAX_CALL_MINUTES ?? 10) * 60_000;
// The session marks the user "away" after ~15 s of silence; hang up if they stay away this long.
const AWAY_HANGUP_MS = Number(process.env.AWAY_HANGUP_SECONDS ?? 60) * 1000;

class Companion extends voice.Agent {
  constructor(opts: { recalled: MemoryRow[]; userId: string; lang: Lang; mem?: Memory; emit: Emit }) {
    const { recalled, userId, lang, mem, emit } = opts;
    const day = (r: MemoryRow) => new Date(r.created_at).toISOString().slice(0, 10);
    super({
      instructions:
        persona(lang) +
        // Without today's date the model can't tell a past exam from an upcoming one.
        `\n\nToday is ${todayLabel()}.` +
        (recalled.length
          ? `\n\nWhat you remember about this user from earlier sessions (with the date it was noted):\n` +
            recalled.map((r) => `- ${r.fact} (noted ${day(r)})`).join('\n')
          : // Without this the LLM happily invents shared history ("we talked for hours last time").
            '\n\nYou have NO memories of this user from earlier sessions. Never claim or imply past conversations; if asked, say honestly that you do not remember anything yet.'),
    });
    this.emit = emit;
    this.lang = lang;
    this.userId = userId;
    this.mem = mem;
    this.known = recalled.map((r) => ({ id: r.id, fact: r.fact }));
  }
  private emit: Emit;
  private lang: Lang;
  private userId: string;
  private mem?: Memory;
  /** Facts the extractor may update or skip (recalled at start + learned during this call). */
  private known: KnownFact[];
  private learning = Promise.resolve(); // serialize: two quick turns must not race on the same fact

  /** Background memory: never awaited by the voice turn, never blocks or crashes it. */
  private learn(text: string, context: string) {
    const mem = this.mem;
    if (!mem) return;
    this.learning = this.learning
      .then(async () => {
        for (const x of await extractFacts(text, { context, known: this.known })) {
          const id = await mem.remember(this.userId, x.fact, x.replacesId);
          if (x.replacesId) this.known = this.known.filter((k) => k.id !== x.replacesId);
          if (!id) continue;
          this.known.push({ id, fact: x.fact });
          this.emit({ type: 'memory', fact: x.fact });
        }
      })
      .catch((e) => console.warn('memory learn failed:', String(e)));
  }

  // Safety runs BEFORE the LLM sees the turn. On risk: fixed crisis reply + StopResponse (LLM skipped).
  override async onUserTurnCompleted(chatCtx: llm.ChatContext, newMessage: llm.ChatMessage): Promise<void> {
    const text = newMessage.textContent ?? '';
    const v = await checkSafety(text);
    this.emit({ type: 'safety', flagged: v.flag, layer: v.layer, ms: v.ms });
    if (v.flag) {
      // Session language (from the device), not a guess from the text: a fixed, human-reviewed message.
      this.session.say(LANG_PROFILE[this.lang].crisis, { allowInterruptions: false });
      throw new voice.StopResponse();
    }
    // Only for safe turns: crisis content is not turned into "personal facts".
    // The last few turns let the extractor understand corrections like "no, not today, on Friday".
    const context = chatCtx.items
      .filter((i): i is llm.ChatMessage => i.type === 'message' && (i.role === 'user' || i.role === 'assistant'))
      .slice(-4)
      .map((m) => `${m.role}: ${m.textContent ?? ''}`)
      .join('\n');
    this.learn(text, context);
  }
}

function buildSession(pipeline: Pipeline, vad: silero.VAD, lang: Lang): voice.AgentSession {
  const p = LANG_PROFILE[lang];
  const voiceId = process.env[p.voiceEnv]; // optional native-speaker voice; Cartesia default otherwise
  if (pipeline === 'realtime') console.warn('realtime needs Gemini Live plugin — falling back to cascaded');
  return new voice.AgentSession({
    vad,
    stt: new deepgram.STT({ language: p.stt, model: 'nova-3' }), // 'multi' does not cover Turkish
    llm: new openai.LLM({ model: 'gemini-3.5-flash-lite' }),
    tts: new cartesia.TTS({ model: 'sonic-3', language: p.tts, ...(voiceId ? { voice: voiceId } : {}) }),
    turnHandling: {
      turnDetection: new inference.TurnDetector(),
      endpointing: { minDelay: 500, maxDelay: 3000 },
      interruption: { enabled: true, minDuration: 500, minWords: 1 },
    },
  });
}

export default defineAgent({
  // Load models once per process, not per call (cold start would add seconds to the first turn).
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const participant = await ctx.waitForParticipant();
    const userId = participant.identity;
    let meta: Partial<ParticipantMeta> = {};
    try {
      meta = JSON.parse(participant.metadata || '{}');
    } catch { }
    const pipeline: Pipeline = meta.pipeline === 'realtime' ? 'realtime' : 'cascaded';
    // Re-validate: metadata can come from any token (e.g. the LiveKit Console), not only from our API.
    const lang: Lang = isLang(meta.lang) ? meta.lang : DEFAULT_LANG;

    const emit: Emit = (ev) => void publishEvent(ctx.room.localParticipant, ev);
    emit({ type: 'pipeline', pipeline });

    const mem = process.env.DATABASE_URL ? new Memory(process.env.DATABASE_URL) : undefined;
    const recalled = mem
      ? await mem.recall(userId, 'who is this user, goals, important people, triggers', 5).catch((e) => {
        console.warn('memory disabled:', String(e));
        return [] as MemoryRow[];
      })
      : [];

    const session = buildSession(pipeline, ctx.proc.userData.vad as silero.VAD, lang);

    const tracker = new LatencyTracker();
    const usage = new metrics.ModelUsageCollector();
    const startedAt = Date.now();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usage.collect(ev.metrics);
      const turn = tracker.add(ev.metrics as never);
      if (turn) emit({ type: 'latency', ...turn });
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) return;
      emit({ type: 'transcript', role: item.role, text: item.textContent ?? '', interrupted: item.interrupted, at: Date.now() });
    });

    ctx.addShutdownCallback(async () => {
      console.log(summarize(usage, Date.now() - startedAt));
      await mem?.close();
    });

    await session.start({ agent: new Companion({ recalled, userId, lang, mem, emit }), room: ctx.room });
    session.generateReply({ instructions: greeting(lang) });

    // Cost guards for a public demo: every open minute bills STT (Deepgram meters silence too).
    let ending = false;
    const endCall = async (reason: string) => {
      if (ending) return;
      ending = true;
      console.log(`ending call: ${reason}`);
      await session
        .say(LANG_PROFILE[lang].goodbye, { allowInterruptions: false })
        .waitForPlayout()
        .catch(() => undefined);
      await ctx.deleteRoom().catch(() => undefined); // disconnects the user too
      ctx.shutdown(reason);
    };
    const maxCall = setTimeout(() => void endCall('max call duration'), MAX_CALL_MS);
    let awayTimer: NodeJS.Timeout | undefined;
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      clearTimeout(awayTimer);
      if (ev.newState === 'away') awayTimer = setTimeout(() => void endCall('user silent'), AWAY_HANGUP_MS);
    });
    ctx.addShutdownCallback(async () => {
      clearTimeout(maxCall);
      clearTimeout(awayTimer);
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
