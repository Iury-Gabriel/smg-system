FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN chmod +x docker-entrypoint.sh

EXPOSE 3344

CMD ["./docker-entrypoint.sh"]
