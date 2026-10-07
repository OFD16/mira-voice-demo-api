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

type AnyMetric = { type: string; speechId?: string;[k: string]: unknown };

// Groups EOU / LLM / TTS metrics by speechId and returns a TurnLatency once a turn has all three.
export class LatencyTracker {
  private turns = new Map<string, Partial<TurnLatency>>();
  private static MAX_PENDING = 50;

  add(m: AnyMetric): TurnLatency | null {
    if (!m.speechId) return null;
    const t = this.turns.get(m.speechId) ?? { speechId: m.speechId };
    switch (m.type) {
      case 'eou_metrics':
        t.eouMs = m.endOfUtteranceDelayMs as number;
        t.sttMs = m.transcriptionDelayMs as number;
        break;
      case 'llm_metrics':
        t.ttftMs = m.ttftMs as number;
        break;
      case 'tts_metrics':
        t.ttfbMs = m.ttfbMs as number;
        break;
      default:
        return null; // ignore unknown metric types
    }
    if (t.eouMs !== undefined && t.ttftMs !== undefined && t.ttfbMs !== undefined) {
      t.totalMs = t.eouMs + t.ttftMs + t.ttfbMs;
      this.turns.delete(m.speechId);
      return t as TurnLatency;
    }

    if (!this.turns.has(m.speechId) && this.turns.size >= LatencyTracker.MAX_PENDING) {
      this.turns.delete(this.turns.keys().next().value!);
    }
    this.turns.set(m.speechId, t);
    return null;
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
