import { z } from 'zod';

// Env is validated ONCE at startup. A missing key should crash the process immediately
// with a clear message — not 20 minutes later inside a voice call.
const EnvSchema = z.object({
  LIVEKIT_URL: z.string().startsWith('wss://', 'LIVEKIT_URL must start with wss://'),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().url().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  CARTESIA_API_KEY: z.string().optional(),
  DEMO_API_KEY: z.string().min(16, 'DEMO_API_KEY must be at least 16 characters'),
  DATABASE_URL: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  MAX_SESSIONS_PER_DAY: z.coerce.number().int().positive().default(200),
  TRUST_PROXY: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
});

export type Config = z.infer<typeof EnvSchema>;

// TODO(L1-01): Validate `env` with EnvSchema.
//   - On failure throw an Error whose message lists the invalid keys (e.g. "Invalid env: LIVEKIT_URL, DEMO_API_KEY").
//   - Never print the VALUES — they are secrets.
//   Terms: fail-fast, 12-factor config. Test: npm test -- --test-name-pattern=config
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid env: ${errors}`);
  }
  return parsed.data;
}
