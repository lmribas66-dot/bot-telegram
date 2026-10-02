FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright-core install --with-deps chromium
COPY bot.js index.html ./
ENV NODE_ENV=production
CMD ["node", "bot.js"]
