FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3003

CMD ["sh", "-c", "npm run migrate && node dist/src/main.js"]
