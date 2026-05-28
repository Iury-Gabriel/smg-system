FROM node:20-bookworm-slim

ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN printf "%s\n" "$BUILD_SHA" > BUILD_VERSION
RUN chmod +x docker-entrypoint.sh

EXPOSE 3344

CMD ["./docker-entrypoint.sh"]
