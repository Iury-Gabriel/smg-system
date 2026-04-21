#!/bin/sh
set -eu

echo "[backend] gerando cliente Prisma..."
npm run prisma:generate

if [ -f "prisma/migrations/migration_lock.toml" ] && grep -q 'provider = "postgresql"' prisma/migrations/migration_lock.toml; then
  echo "[backend] aplicando migrations (prisma migrate deploy)..."
  if ! npx prisma migrate deploy; then
    echo "[backend] migrate deploy falhou, aplicando fallback com prisma db push..."
  fi
else
  echo "[backend] migrations sqlite detectadas, pulando migrate deploy e usando db push para PostgreSQL..."
fi

echo "[backend] sincronizando schema (prisma db push)..."
npm run prisma:push

echo "[backend] executando seed inicial..."
npm run seed

echo "[backend] iniciando server + worker..."
exec npm run start
