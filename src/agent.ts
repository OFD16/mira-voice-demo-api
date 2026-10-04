// Mira voice agent worker. Joins every room created by POST /session.
//   npm run dev:agent      (connects to LiveKit Cloud and waits for rooms)
//   npm run console        (talk in the terminal, no app needed)
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
import { z } from 'zod';
import { type MiraEvent, publishEvent } from './events.js';
import { LatencyTracker } from './latency.js';
import { Memory } from './memory.js';
import { GREETING, PERSONA } from './persona.js';
import { CRISIS_REPLY_EN, CRISIS_REPLY_TR, checkSafety, looksTurkish } from './safety.js';
import type { ParticipantMeta, Pipeline } from './session.js';

type Emit = (ev: MiraEvent) => void;

class Companion extends voice.Agent {
  constructor(opts: { recalled: string[]; userId: string; mem?: Memory; emit: Emit }) {
    const { recalled, userId, mem, emit } = opts;
    super({
      instructions:
        PERSONA +
        (recalled.length ? `\n\nWhat you remember about this user from earlier sessions:\n- ${recalled.join('\n- ')}` : ''),
      tools: mem
        ? [
            llm.tool({
              name: 'remember',
              description: 'Store one stable personal fact about the user for future sessions.',
              parameters: z.object({ fact: z.string().describe('Short third-person sentence.') }),
              execute: async ({ fact }) => {
                await mem.remember(userId, fact);
                emit({ type: 'memory', fact });
                return 'saved';
              },
            }),
          ]
        : undefined,
    });
    this.emit = emit;
  }
  private emit: Emit;

  // TODO(L1-07): Run the safety check BEFORE the LLM sees the user's turn.
  //   - text = newMessage.textContent ?? ''
  //   - v = await checkSafety(text); emit({ type:'safety', flagged:v.flag, layer:v.layer, ms:v.ms })
  //   - if v.flag: this.session.say(<TR or EN crisis reply>, { allowInterruptions:false }) and
  //     throw new voice.StopResponse()   ← this skips the LLM entirely for this turn
  //   Common mistake: asking the LLM to "be careful" in the prompt instead — a prompt can be jailbroken, code can't.
  //   Terms: deterministic crisis protocol, StopResponse, onUserTurnCompleted hook.
  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, newMessage: llm.ChatMessage): Promise<void> {
    // @sol-start L1-07
    const text = newMessage.textContent ?? '';
    const v = await checkSafety(text);
    this.emit({ type: 'safety', flagged: v.flag, layer: v.layer, ms: Math.round(v.ms) });
    if (v.flag) {
      this.session.say(looksTurkish(text) ? CRISIS_REPLY_TR : CRISIS_REPLY_EN, { allowInterruptions: false });
      throw new voice.StopResponse();
    }
    // @sol-end
  }
}

// TODO(L1-08): Build the AgentSession for the selected pipeline.
//   cascaded: stt = deepgram nova-3 (language 'multi'), llm = openai gpt-4o-mini, tts = cartesia sonic-2, vad = prewarmed,
//             turnHandling: { turnDetection: new inference.TurnDetector(),
//                             endpointing: { minDelay: 500, maxDelay: 3000 },
//                             interruption: { enabled: true, minDuration: 500, minWords: 1 } }
//   realtime: llm = new openai.realtime.RealtimeModel({ voice: 'alloy' })  (no stt/tts — speech-to-speech)
//   Common mistake: minDuration 0 → the agent stops talking every time the user coughs (false interruption).
//   Terms: cascaded vs S2S, VAD, endpointing, turn detector, barge-in.
function buildSession(pipeline: Pipeline, vad: silero.VAD): voice.AgentSession {
  // @sol-start L1-08
  if (pipeline === 'realtime') {
    return new voice.AgentSession({ llm: new openai.realtime.RealtimeModel({ voice: 'alloy' }) });
  }
  return new voice.AgentSession({
    vad,
    stt: new deepgram.STT({ model: 'nova-3', language: 'multi' }),
    llm: new openai.LLM({ model: 'gpt-4o-mini', temperature: 0.7 }),
    tts: new cartesia.TTS({ model: 'sonic-2' }),
    turnHandling: {
      turnDetection: new inference.TurnDetector(),
      endpointing: { minDelay: Number(process.env.MIN_DELAY ?? 500), maxDelay: 3000 },
      interruption: { enabled: true, minDuration: 500, minWords: 1 },
    },
  });
  // @sol-end
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
    } catch {}
    const pipeline: Pipeline = meta.pipeline === 'realtime' ? 'realtime' : 'cascaded';

    const emit: Emit = (ev) => void publishEvent(ctx.room.localParticipant, ev);
    emit({ type: 'pipeline', pipeline });

    const mem = process.env.DATABASE_URL ? new Memory(process.env.DATABASE_URL) : undefined;
    const recalled = mem
      ? await mem.recall(userId, 'who is this user, goals, important people, triggers', 5).catch((e) => {
          console.warn('memory disabled:', String(e));
          return [] as string[];
        })
      : [];

    const session = buildSession(pipeline, ctx.proc.userData.vad as silero.VAD);

    const tracker = new LatencyTracker();
    const usage = new metrics.UsageCollector();
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
      console.log('usage', JSON.stringify(usage.getSummary()));
      await mem?.close();
    });

    await session.start({ agent: new Companion({ recalled, userId, mem, emit }), room: ctx.room });
    session.generateReply({ instructions: GREETING });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
