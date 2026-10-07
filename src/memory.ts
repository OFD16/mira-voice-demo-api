// Long-term memory: user facts in Postgres + pgvector. At session start, the top-K most relevant
// facts are injected into the system prompt (RAG).
import OpenAI from 'openai';
import pg from 'pg';
import pgvector from 'pgvector/pg';
import { recordSideUsage } from './usage.js';

export type Query = { text: string; values: unknown[] };
export type MemoryRow = { id: string; fact: string; created_at: string };

// TODO(L1-05): Build the SQL for "top-K facts closest to this embedding, for THIS user only".
//   - SELECT id, fact FROM memories WHERE user_id = $1 ORDER BY embedding <=> $2 LIMIT $3
//   - values: [userId, embeddingSql, k]
//   Common mistake: forgetting `WHERE user_id = $1` → one user's private mental-health notes leak into another's prompt.
//   Common mistake #2: string-concatenating userId into SQL → SQL injection. Always use $1 placeholders.
//   Terms: embedding, cosine distance (<=>), RAG, HNSW index, tenant isolation. Test: npm test -- --test-name-pattern=memory
export function recallQuery(userId: string, embeddingSql: string, k: number): Query {
  return {
    text: 'SELECT id::text, fact, created_at FROM memories WHERE user_id = $1 ORDER BY embedding <=> $2 LIMIT $3',
    values: [userId, embeddingSql, k],
  }
}

export const deleteQuery = (userId: string, id: string): Query => ({
  text: 'DELETE FROM memories WHERE user_id = $1 AND id = $2',
  values: [userId, id],
});

let _oa: OpenAI | undefined;
const oa = () => (_oa ??= new OpenAI());

// Memory extraction runs OFF the voice hot path (fire-and-forget after each turn), instead of a `remember`
// tool on the chat LLM: the fast model (flash-lite) almost never called the tool (0/5), and the model that
// did (3.8-flash) needed ~2-4 s to first token. A tiny dedicated call is fast, cheap and testable.
/** "Tuesday, 2026-10-06" in the server's local time zone. Facts must not say "today"/"Friday": they rot. */
export function todayLabel(d = new Date()): string {
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'long' })}, ${iso}`;
}

const EXTRACT_PROMPT = (today: string, known: string) => `You maintain a voice companion's long-term memory about the user. Today is ${today}.
From the user's LATEST message (use the recent conversation only to understand it), extract up to 3 stable personal facts.
Stable = name, goals, upcoming events, important people or pets, recurring stressors, preferences.
NOT stable = momentary moods, greetings, small talk, questions to the assistant.
Rules:
- One fact per item: a name and an exam are two facts.
- Convert relative dates to absolute ones: "today", "tomorrow", "on Friday" → e.g. "on Friday, 2026-10-09".
- If a fact corrects or updates a known fact, write the corrected full fact and set "replaces" to that fact's number.
- Skip facts that are already known unchanged.
- Each fact is one short third-person English sentence, using the user's name or "they".
- Keep names exactly as the user writes them, including letters like ç ğ ı ö ş ü (Ömer, not Omer).
Known facts:
${known || '(none)'}
Reply ONLY with JSON: {"facts": [{"fact": string, "replaces": number | null}]}  (empty list if nothing new)`;

export type KnownFact = { id: string; fact: string };
export type Extracted = { fact: string; replacesId?: string };

/** Returns new/corrected facts (empty when the message has nothing worth remembering). */
export async function extractFacts(
  text: string,
  { context = '', known = [] as KnownFact[], today = todayLabel() } = {},
): Promise<Extracted[]> {
  if (text.trim().length < 8) return [];
  const knownList = known.map((k, i) => `${i + 1}. ${k.fact}`).join('\n');
  const r = await oa().chat.completions.create({
    model: 'gemini-3.5-flash-lite',
    temperature: 0,
    max_tokens: 300, // hidden thinking tokens count against this
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACT_PROMPT(today, knownList) },
      { role: 'user', content: `Recent conversation:\n${context || '(none)'}\n\nLatest user message:\n${text}` },
    ],
  });
  recordSideUsage('extract', r.usage);
  try {
    const out = JSON.parse(r.choices[0]?.message?.content ?? '{}') as { facts?: unknown };
    if (!Array.isArray(out.facts)) return [];
    return out.facts
      .slice(0, 3)
      .filter((f): f is { fact: string; replaces?: unknown } => typeof f?.fact === 'string' && f.fact.trim() !== '')
      .map((f) => ({
        fact: f.fact.trim().slice(0, 300),
        replacesId: typeof f.replaces === 'number' ? known[f.replaces - 1]?.id : undefined,
      }));
  } catch {
    return []; // malformed output = remember nothing (never store garbage)
  }
}

/** Cosine distance below this = "we already know this" (e.g. the user repeats their name every call). */
const DUPLICATE_DISTANCE = 0.12;

export class Memory {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5 });
    this.pool.on('connect', (c) => pgvector.registerTypes(c));
    this.ready = this.init();
  }

  private async init() {
    const c = await this.pool.connect();
    try {
      await c.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pgvector.registerTypes(c);
      await c.query(`CREATE TABLE IF NOT EXISTS memories (
        id bigserial PRIMARY KEY,
        user_id text NOT NULL,
        fact text NOT NULL,
        embedding vector(1536) NOT NULL,
        created_at timestamptz DEFAULT now())`);
      await c.query('CREATE INDEX IF NOT EXISTS memories_user ON memories (user_id)');
      await c.query('CREATE INDEX IF NOT EXISTS memories_hnsw ON memories USING hnsw (embedding vector_cosine_ops)');
    } finally {
      c.release();
    }
  }

  private async embed(text: string): Promise<string> {
    const r = await oa().embeddings.create({ model: 'gemini-embedding-001', input: text, dimensions: 1536 });
    recordSideUsage('embedding', r.usage as { prompt_tokens?: number } | undefined);
    return pgvector.toSql(r.data[0]!.embedding);
  }

  /**
   * Stores the fact unless a near-identical one exists for this user. With `replacesId` the outdated fact is
   * removed first (user corrected it: "not today, Friday"). Returns the new row id, or null if skipped.
   */
  async remember(userId: string, fact: string, replacesId?: string): Promise<string | null> {
    await this.ready;
    const emb = await this.embed(fact);
    if (replacesId) await this.delete(userId, replacesId); // scoped by user_id: can't delete someone else's row
    const dup = await this.pool.query(
      'SELECT 1 FROM memories WHERE user_id = $1 AND embedding <=> $2 < $3 LIMIT 1',
      [userId, emb, DUPLICATE_DISTANCE],
    );
    if (dup.rowCount) return null;
    const r = await this.pool.query('INSERT INTO memories (user_id, fact, embedding) VALUES ($1, $2, $3) RETURNING id::text', [
      userId,
      fact.slice(0, 300),
      emb,
    ]);
    return r.rows[0].id as string;
  }

  async recall(userId: string, query: string, k = 5): Promise<MemoryRow[]> {
    await this.ready;
    const q = recallQuery(userId, await this.embed(query), k);
    return (await this.pool.query(q.text, q.values)).rows as MemoryRow[];
  }

  async list(userId: string): Promise<MemoryRow[]> {
    await this.ready;
    const r = await this.pool.query(
      'SELECT id::text, fact, created_at FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [userId],
    );
    return r.rows as MemoryRow[];
  }

  async delete(userId: string, id: string): Promise<boolean> {
    await this.ready;
    const q = deleteQuery(userId, id);
    return ((await this.pool.query(q.text, q.values)).rowCount ?? 0) > 0;
  }

  async close() {
    await this.pool.end();
  }
}
