// Agent -> mobile app events over a LiveKit data channel (same contract as mira-voice-demo-app/src/events.ts).
export const EVENTS_TOPIC = 'mira.events';

export type MiraEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; interrupted: boolean; at: number }
  | { type: 'latency'; speechId: string; eouMs: number; ttftMs: number; ttfbMs: number; totalMs: number }
  | { type: 'safety'; flagged: boolean; layer: string; ms: number }
  | { type: 'memory'; fact: string }
  | { type: 'pipeline'; pipeline: 'cascaded' | 'realtime' };

type DataPublisher = {
  publishData(data: Uint8Array, opts: { reliable?: boolean; topic?: string }): Promise<void>;
};

export const encodeEvent = (ev: MiraEvent) => new TextEncoder().encode(JSON.stringify(ev));

// TODO(L1-06): Publish one event to the app.
//   - encodeEvent(ev) → publisher.publishData(bytes, { reliable: true, topic: EVENTS_TOPIC })
//   - swallow + log errors: a UI event must NEVER crash the voice session
//   Common mistake: reliable:false (lossy) for transcripts → random missing lines on mobile networks.
//   Terms: data channel, reliable vs lossy, topic. Test: npm test -- --test-name-pattern=events
export async function publishEvent(publisher: DataPublisher | undefined, ev: MiraEvent): Promise<void> {
  if (!publisher) return;
  try {
    const bytes = encodeEvent(ev);
    await publisher.publishData(bytes, { reliable: true, topic: EVENTS_TOPIC });
  } catch (err) {
    console.error('publishEvent failed', String(err), ev);
   }
}
