import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { encodeEvent, EVENTS_TOPIC, publishEvent } from '../src/events.js';
import { LatencyTracker } from '../src/latency.js';
import { deleteQuery, recallQuery } from '../src/memory.js';
import { checkSafety } from '../src/safety.js';
import { createSession } from '../src/session.js';

const ENV = {
  LIVEKIT_URL: 'wss://demo.livekit.cloud',
  LIVEKIT_API_KEY: 'APIdemo',
  LIVEKIT_API_SECRET: 'super-secret-value-that-must-not-leak',
  OPENAI_API_KEY: 'sk-test',
  DEMO_API_KEY: '0123456789abcdef0123',
};
const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString());

describe('L1-01 config', () => {
  it('parses a valid env and defaults PORT', () => {
    assert.equal(loadConfig(ENV).PORT, 3000);
  });
  it('fails fast listing bad keys, without printing secrets', () => {
    assert.throws(
      () => loadConfig({ ...ENV, LIVEKIT_URL: 'http://x', DEMO_API_KEY: 'short' }),
      (e: Error) => /LIVEKIT_URL/.test(e.message) && /DEMO_API_KEY/.test(e.message) && !e.message.includes('short'),
    );
  });
});

describe('L1-02 session', () => {
  it('issues a short-lived, least-privilege token in a unique room', async () => {
    const cfg = loadConfig(ENV);
    const a = await createSession(cfg, 'omer', 'cascaded');
    const b = await createSession(cfg, 'omer', 'cascaded');
    assert.notEqual(a.roomName, b.roomName, 'each session needs its own room');
    assert.ok(a.roomName.includes('omer'));
    const p = jwtPayload(a.token);
    assert.equal(p.sub, 'omer');
    assert.ok(p.exp - p.nbf <= 15 * 60 + 5, 'ttl must be <= 15 min');
    assert.equal(p.video.room, a.roomName);
    assert.equal(p.video.roomJoin, true);
    assert.equal(p.video.canPublishData, true);
    assert.ok(!p.video.roomAdmin && !p.video.roomCreate, 'no admin grants');
    assert.equal(JSON.parse(p.metadata).pipeline, 'cascaded');
    assert.ok(!JSON.stringify(a).includes(ENV.LIVEKIT_API_SECRET), 'secret must never leave the server');
  });
});

describe('L1-03 safety', () => {
  const never = () => new Promise<string>(() => {});
  it('keyword layer flags without calling the classifier', async () => {
    let called = false;
    const v = await checkSafety('Artık yaşamak istemiyorum', { classify: async () => ((called = true), 'SAFE') });
    assert.equal(v.flag, true);
    assert.equal(v.layer, 'keyword');
    assert.equal(called, false);
  });
  it('classifier SAFE passes', async () => {
    const v = await checkSafety('Sınavım var, stresliyim', { classify: async () => ' safe ' });
    assert.deepEqual([v.flag, v.layer], [false, 'classifier']);
  });
  it('unexpected classifier output is RISK', async () => {
    const v = await checkSafety('hmm', { classify: async () => 'I am not sure' });
    assert.equal(v.flag, true);
  });
  it('timeout is FAIL-CLOSED', async () => {
    const v = await checkSafety('Herkes bensiz daha iyi olur', { classify: never, timeoutMs: 50 });
    assert.deepEqual([v.flag, v.layer], [true, 'fail_closed']);
    assert.ok(v.ms < 500);
  });
  it('provider error is FAIL-CLOSED', async () => {
    const v = await checkSafety('hello', { classify: async () => { throw new Error('503'); } });
    assert.deepEqual([v.flag, v.layer], [true, 'fail_closed']);
  });
  it('empty text is not flagged', async () => {
    assert.equal((await checkSafety('   ')).flag, false);
  });
});

describe('L1-04 latency', () => {
  it('emits one total per turn and cleans up', () => {
    const t = new LatencyTracker();
    assert.equal(t.add({ type: 'eou_metrics', speechId: 's1', endOfUtteranceDelayMs: 500, transcriptionDelayMs: 120 }), null);
    assert.equal(t.add({ type: 'llm_metrics', speechId: 's1', ttftMs: 300 }), null);
    assert.equal(t.add({ type: 'llm_metrics', speechId: 's2', ttftMs: 999 }), null);
    const r = t.add({ type: 'tts_metrics', speechId: 's1', ttfbMs: 150 });
    assert.ok(r);
    assert.equal(r.totalMs, 950);
    assert.equal(t.pending, 1, 'finished turns must be removed');
    assert.equal(t.add({ type: 'vad_metrics' }), null);
  });
});

describe('L1-05 memory', () => {
  it('recall is scoped to the user and parameterized', () => {
    const q = recallQuery("x' OR 1=1 --", '[0.1,0.2]', 3);
    assert.match(q.text, /WHERE\s+user_id\s*=\s*\$1/i);
    assert.match(q.text, /ORDER BY\s+embedding\s*<=>\s*\$2/i);
    assert.match(q.text, /LIMIT\s+\$3/i);
    assert.ok(!q.text.includes('OR 1=1'), 'never concatenate user input into SQL');
    assert.deepEqual(q.values, ["x' OR 1=1 --", '[0.1,0.2]', 3]);
  });
  it('delete is scoped to the user', () => {
    assert.match(deleteQuery('u', '1').text, /user_id\s*=\s*\$1/);
  });
});

describe('L1-06 events', () => {
  it('publishes reliably on the events topic and never throws', async () => {
    const calls: { opts: { reliable?: boolean; topic?: string }; data: Uint8Array }[] = [];
    await publishEvent({ publishData: async (data, opts) => void calls.push({ data, opts }) }, { type: 'memory', fact: 'x' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.opts, { reliable: true, topic: EVENTS_TOPIC });
    assert.deepEqual(calls[0]!.data, encodeEvent({ type: 'memory', fact: 'x' }));
    await publishEvent({ publishData: async () => { throw new Error('closed'); } }, { type: 'memory', fact: 'y' });
    await publishEvent(undefined, { type: 'memory', fact: 'z' });
  });
});
