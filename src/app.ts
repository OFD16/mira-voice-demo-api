import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { MemoryRow } from './memory.js';
import { DEFAULT_LANG, LANGS } from './languages.js';
import { createSession } from './session.js';

export type MemoryStore = {
  list(userId: string): Promise<MemoryRow[]>;
  delete(userId: string, id: string): Promise<boolean>;
};

const UserId = z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/, 'userId: 3-40 chars, letters/digits/_/-');
const SessionBody = z.object({
  userId: UserId,
  pipeline: z.enum(['cascaded', 'realtime']).default('cascaded'),
  // Allowlist, not free text: this value reaches the LLM prompt (prompt-injection guard).
  lang: z.enum(LANGS).default(DEFAULT_LANG),
});

// TODO(L1-09): Demo-level auth middleware. The app sends header `x-demo-key`.
//   - missing or wrong → 401 { error: 'unauthorized' }
//   - compare with crypto.timingSafeEqual on equal-length Buffers (plain === leaks timing)
//   Common mistake: putting LIVEKIT_API_SECRET in the mobile app "to skip the API". Anyone can unzip an APK.
//   Real prod: replace with your user auth (JWT from your login), this key only identifies the app build.
//   Terms: shared secret, timing attack, secret in client. Test: npm test -- --test-name-pattern=api
export function requireDemoKey(expected: string) {
  // Length is already enforced by EnvSchema (>= 16 chars) in config.ts — validate in one place.
  const want = Buffer.from(expected);
  return (req: Request, res: Response, next: NextFunction) => {
    const got = Buffer.from(req.get('x-demo-key') ?? '');
    // timingSafeEqual throws on different lengths, so check length first (length is not the secret).
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

/** Tiny fixed-window rate limiter (per IP). Good enough for a demo; use Redis / API gateway in prod. */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max) {
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    next();
  };
}

/** Global daily budget for a public demo: the key ships inside a public APK, so per-IP limits are not enough. */
export function dailyCap(max: number) {
  let day = '';
  let n = 0;
  return (_req: Request, res: Response, next: NextFunction) => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) [day, n] = [today, 0];
    if (++n > max) {
      res.status(429).json({ error: 'daily_demo_limit' });
      return;
    }
    next();
  };
}

export function buildApp(cfg: Config, memory?: MemoryStore) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Dokploy's Traefik the socket IP is the proxy: trust exactly one hop so req.ip (rate limit) is the client.
  if (cfg.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(requireDemoKey(cfg.DEMO_API_KEY));

  app.post('/session', rateLimit(5, 60_000), dailyCap(cfg.MAX_SESSIONS_PER_DAY), async (req, res) => {
    const body = SessionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'bad_request', details: body.error.issues.map((i) => i.message) });
      return;
    }
    res.json(await createSession(cfg, body.data.userId, body.data.pipeline, body.data.lang));
  });

  app.get('/memories/:userId', async (req, res) => {
    const u = UserId.safeParse(req.params.userId);
    if (!u.success) return void res.status(400).json({ error: 'bad_request' });
    if (!memory) return void res.json({ memories: [], enabled: false });
    res.json({ memories: await memory.list(u.data), enabled: true });
  });

  app.delete('/memories/:userId/:id', async (req, res) => {
    const u = UserId.safeParse(req.params.userId);
    if (!u.success || !/^\d+$/.test(req.params.id)) return void res.status(400).json({ error: 'bad_request' });
    if (!memory) return void res.status(404).json({ error: 'memory_disabled' });
    res.json({ deleted: await memory.delete(u.data, req.params.id) });
  });

  // Never leak stack traces to clients.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
