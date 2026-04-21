#!/bin/sh
set -eu

RUNTIME_SCHEMA_PATH="prisma/schema.runtime.prisma"

echo "[backend] preparando schema Prisma para PostgreSQL..."
sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma > "$RUNTIME_SCHEMA_PATH"

echo "[backend] gerando cliente Prisma..."
npx prisma generate --schema "$RUNTIME_SCHEMA_PATH"

echo "[backend] aplicando migrations (prisma migrate deploy)..."
if ! npx prisma migrate deploy --schema "$RUNTIME_SCHEMA_PATH"; then
  echo "[backend] migrate deploy falhou, aplicando fallback com prisma db push..."
fi

echo "[backend] sincronizando schema (prisma db push)..."
npx prisma db push --schema "$RUNTIME_SCHEMA_PATH"

echo "[backend] iniciando server + worker..."
exec npm run start
