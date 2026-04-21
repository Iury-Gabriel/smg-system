#!/bin/sh
set -eu

echo "[backend] gerando cliente Prisma..."
npm run prisma:generate

echo "[backend] aplicando migrations (prisma migrate deploy)..."
npx prisma migrate deploy

echo "[backend] sincronizando schema (prisma db push)..."
npm run prisma:push

echo "[backend] iniciando server + worker..."
exec npm run start
