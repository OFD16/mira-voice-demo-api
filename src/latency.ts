// Per-turn latency budget: user stops speaking -> first agent audio.
// LiveKit emits separate metric events per component, all tagged with the same `speechId`.

export type TurnLatency = {
  speechId: string;
  eouMs: number;    // end-of-utterance decision (endpointing / turn detector)
  sttMs: number;    // final transcript delay (informational, overlaps with EOU)
  ttftMs: number;   // LLM time to first token
  ttfbMs: number;   // TTS time to first byte
  totalMs: number;  // eou + ttft + ttfb
};

type AnyMetric = { type: string; speechId?: string; [k: string]: unknown };

// TODO(L1-04): Aggregate metrics by speechId and return a TurnLatency once a turn has all three parts.
//   - 'eou_metrics'  -> endOfUtteranceDelayMs, transcriptionDelayMs
//   - 'llm_metrics'  -> ttftMs
//   - 'tts_metrics'  -> ttfbMs
//   - ignore metrics without speechId
//   - when eou + llm + tts are all present: delete the entry (no memory leak) and return the TurnLatency
//   - otherwise return null
//   Common mistake: averaging per component across turns — you lose which turn was slow; p95 needs per-turn totals.
//   Terms: latency budget, TTFT, TTFB, p50/p95. Test: npm test -- --test-name-pattern=latency
export class LatencyTracker {
  private turns = new Map<string, Partial<TurnLatency>>();

  add(m: AnyMetric): TurnLatency | null {
    // @sol-start L1-04
    const id = m.speechId;
    if (!id) return null;
    const t = this.turns.get(id) ?? { speechId: id };
    if (m.type === 'eou_metrics') {
      t.eouMs = Number(m.endOfUtteranceDelayMs);
      t.sttMs = Number(m.transcriptionDelayMs);
    } else if (m.type === 'llm_metrics') t.ttftMs = Number(m.ttftMs);
    else if (m.type === 'tts_metrics') t.ttfbMs = Number(m.ttfbMs);
    else return null;
    this.turns.set(id, t);
    if (t.eouMs == null || t.ttftMs == null || t.ttfbMs == null) return null;
    this.turns.delete(id);
    return { ...(t as TurnLatency), totalMs: Math.round(t.eouMs + t.ttftMs + t.ttfbMs) };
    // @sol-end
  }

  get pending() {
    return this.turns.size;
  }
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
