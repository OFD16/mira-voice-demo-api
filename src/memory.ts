// Long-term memory: user facts in Postgres + pgvector. At session start, the top-K most relevant
// facts are injected into the system prompt (RAG).
import OpenAI from 'openai';
import pg from 'pg';
import pgvector from 'pgvector/pg';

export type Query = { text: string; values: unknown[] };
export type MemoryRow = { id: string; fact: string; created_at: string };

// TODO(L1-05): Build the SQL for "top-K facts closest to this embedding, for THIS user only".
//   - SELECT id, fact FROM memories WHERE user_id = $1 ORDER BY embedding <=> $2 LIMIT $3
//   - values: [userId, embeddingSql, k]
//   Common mistake: forgetting `WHERE user_id = $1` → one user's private mental-health notes leak into another's prompt.
//   Common mistake #2: string-concatenating userId into SQL → SQL injection. Always use $1 placeholders.
//   Terms: embedding, cosine distance (<=>), RAG, HNSW index, tenant isolation. Test: npm test -- --test-name-pattern=memory
export function recallQuery(userId: string, embeddingSql: string, k: number): Query {
  throw new Error('TODO(L1-05) — see docs/LESSONS.md');
}

export const deleteQuery = (userId: string, id: string): Query => ({
  text: 'DELETE FROM memories WHERE user_id = $1 AND id = $2',
  values: [userId, id],
});

let _oa: OpenAI | undefined;
const oa = () => (_oa ??= new OpenAI());

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
    const r = await oa().embeddings.create({ model: 'text-embedding-3-small', input: text });
    return pgvector.toSql(r.data[0]!.embedding);
  }

  async remember(userId: string, fact: string) {
    await this.ready;
    await this.pool.query('INSERT INTO memories (user_id, fact, embedding) VALUES ($1, $2, $3)', [
      userId,
      fact.slice(0, 300),
      await this.embed(fact),
    ]);
  }

  async recall(userId: string, query: string, k = 5): Promise<string[]> {
    await this.ready;
    const q = recallQuery(userId, await this.embed(query), k);
    return (await this.pool.query(q.text, q.values)).rows.map((r) => r.fact as string);
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
