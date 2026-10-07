# One Dockerfile, two targets (run them as separate services):
#   --target agent   long-lived, CPU-heavy (VAD + turn detector), scales on concurrent calls
#   --target api     short HTTP requests, scales on traffic (default: last stage)
# Dokploy: Build Type = Dockerfile, "Docker Build Stage" = agent | api.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production
# The slim image has no system CA bundle. LiveKit's native (Rust) client verifies TLS against the OS roots,
# so without this the agent registers fine but fails to join rooms ("no native root CA certificates found").
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# tsx is a runtime dependency (we run TypeScript directly), so --omit=dev keeps it.
RUN npm ci --omit=dev && chown -R node:node /app
COPY --chown=node:node . .
USER node

FROM base AS agent
# Download VAD / turn-detector models AS the runtime user, so they land in a cache it can read.
RUN npx tsx src/agent.ts download-files
CMD ["npm", "run", "start:agent"]

FROM base AS api
EXPOSE 3000
CMD ["npm", "run", "start:api"]
