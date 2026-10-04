import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Memory } from './memory.js';

const cfg = loadConfig();
const memory = cfg.DATABASE_URL ? new Memory(cfg.DATABASE_URL) : undefined;
const server = buildApp(cfg, memory).listen(cfg.PORT, '0.0.0.0', () => {
  console.log(`mira api listening on :${cfg.PORT} (memory ${memory ? 'on' : 'off'})`);
});

// Graceful shutdown: finish in-flight requests, close DB pool.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(async () => {
      await memory?.close();
      process.exit(0);
    });
  });
}
