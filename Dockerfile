# One image, two processes (run them as separate services):
#   docker run ... mira-api npm run start:api
#   docker run ... mira-api npm run start:agent
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm i --no-save tsx
COPY . .
RUN npx tsx src/agent.ts download-files || true
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["npm", "run", "start:api"]
