FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000

# Migrations are idempotent (CREATE TABLE IF NOT EXISTS); running on every
# start keeps the compose-up flow single-command.
CMD ["sh", "-c", "npm run migrate && node dist/src/main.js"]
