# One Dockerfile, two targets (run them as separate services):
#   --target agent   long-lived, CPU-heavy (VAD + turn detector), scales on concurrent calls
#   --target api     short HTTP requests, scales on traffic (default: last stage)
# Dokploy: Build Type = Dockerfile, "Docker Build Stage" = agent | api.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm i --no-save tsx && chown -R node:node /app
COPY --chown=node:node . .
USER node

FROM base AS agent
# Download VAD / turn-detector models AS the runtime user, so they land in a cache it can read.
RUN npx tsx src/agent.ts download-files
CMD ["npm", "run", "start:agent"]

FROM base AS api
EXPOSE 3000
CMD ["npm", "run", "start:api"]
