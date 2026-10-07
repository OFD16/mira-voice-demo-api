// Per-call usage + estimated cost. LiveKit's ModelUsageCollector sees the voice pipeline (STT/LLM/TTS);
// our direct OpenAI-SDK calls (safety classifier, memory embeddings) are invisible to it, so we count those here.
// Each LiveKit job runs in its own process, so module-level counters are effectively per call.
import type { metrics } from '@livekit/agents'; // type-only: keeps safety.ts/memory.ts light for unit tests

// USD list prices, checked 2026-10. Prices change: verify on the provider pages before quoting numbers.
//   Gemini: ai.google.dev/gemini-api/docs/pricing · Deepgram: deepgram.com/pricing · Cartesia: cartesia.ai/pricing
export const PRICES = {
  geminiFlashLite: { inPer1M: 0.3, outPer1M: 2.5 }, // gemini-3.5-flash-lite, paid tier (output incl. thinking)
  geminiEmbedding: { inPer1M: 0.2 }, // gemini-embedding-001 is not listed; using gemini-embedding-2's price as an estimate
  deepgramNova3: { perMin: 0.0048 }, // nova-3 monolingual streaming (promo price; regular $0.0077)
  cartesia: { perChar: 0.00005 }, // 1 credit = 1 character; Pro plan rate ($5 / 100K). Free plan: 20K credits/month
};

type Side = { calls: number; inputTokens: number; outputTokens: number };
const zero = (): Side => ({ calls: 0, inputTokens: 0, outputTokens: 0 });
const side = { safety: zero(), extract: zero(), embedding: zero() };

export function recordSideUsage(kind: keyof typeof side, u?: { prompt_tokens?: number; completion_tokens?: number } | null) {
  side[kind].calls++;
  side[kind].inputTokens += u?.prompt_tokens ?? 0;
  side[kind].outputTokens += u?.completion_tokens ?? 0;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** Human-readable call summary for the logs. */
export function summarize(collector: metrics.ModelUsageCollector, callMs: number): string {
  const rows: [string, string, number][] = [];
  for (const u of collector.flatten()) {
    if (u.type === 'llm_usage') {
      const c = (u.inputTokens * PRICES.geminiFlashLite.inPer1M + u.outputTokens * PRICES.geminiFlashLite.outPer1M) / 1e6;
      rows.push([`LLM ${u.model}`, `${u.inputTokens} in / ${u.outputTokens} out tok`, c]);
    } else if (u.type === 'stt_usage') {
      rows.push([`STT ${u.provider}`, `${(u.audioDurationMs / 1000).toFixed(0)} s audio`, (u.audioDurationMs / 60000) * PRICES.deepgramNova3.perMin]);
    } else if (u.type === 'tts_usage') {
      rows.push([`TTS ${u.provider}`, `${u.charactersCount} chars (= credits)`, u.charactersCount * PRICES.cartesia.perChar]);
    }
  }
  const s = side.safety;
  rows.push(['Safety classifier', `${s.calls} calls, ${s.inputTokens} in / ${s.outputTokens} out tok`,
    (s.inputTokens * PRICES.geminiFlashLite.inPer1M + s.outputTokens * PRICES.geminiFlashLite.outPer1M) / 1e6]);
  const x = side.extract;
  rows.push(['Memory extractor', `${x.calls} calls, ${x.inputTokens} in / ${x.outputTokens} out tok`,
    (x.inputTokens * PRICES.geminiFlashLite.inPer1M + x.outputTokens * PRICES.geminiFlashLite.outPer1M) / 1e6]);
  const e = side.embedding;
  rows.push(['Memory embeddings', `${e.calls} calls, ${e.inputTokens} tok`, (e.inputTokens * PRICES.geminiEmbedding.inPer1M) / 1e6]);

  const total = rows.reduce((a, r) => a + r[2], 0);
  const mins = callMs / 60000;
  return [
    `🧾 call usage (${mins.toFixed(1)} min, estimated USD — see PRICES in src/usage.ts)`,
    ...rows.map(([k, v, c]) => `   ${k.padEnd(28)} ${v.padEnd(36)} ${usd(c)}`),
    `   ${'TOTAL'.padEnd(28)} ${''.padEnd(36)} ${usd(total)}  (≈ ${usd(mins > 0 ? total / mins : 0)}/min)`,
    `   not included: LiveKit Cloud agent/connection minutes`,
  ].join('\n');
}
