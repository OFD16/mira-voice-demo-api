# One image, two processes (run them as separate services, see docker-compose.prod.yml):
#   api:   npm run start:api     (short HTTP requests, scales on traffic)
#   agent: npm run start:agent   (long-lived, CPU-heavy: VAD + turn detector, scales on concurrent calls)
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm i --no-save tsx && chown -R node:node /app
COPY --chown=node:node . .
# Download VAD / turn-detector models AS the runtime user, so they land in a cache it can read.
USER node
RUN npx tsx src/agent.ts download-files
EXPOSE 3000
CMD ["npm", "run", "start:api"]
