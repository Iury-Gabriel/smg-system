#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="/tmp/smg-auto-deploy.lock"
LOG_PREFIX="[auto-deploy]"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$LOG_PREFIX another run is in progress, skipping."
  exit 0
fi

cd "$ROOT_DIR"

if [ -n "$(git status --porcelain)" ]; then
  echo "$LOG_PREFIX working tree is dirty, skipping to avoid conflicts."
  exit 0
fi

git fetch --prune "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "$DEPLOY_REMOTE/$DEPLOY_BRANCH")"
BASE_SHA="$(git merge-base HEAD "$DEPLOY_REMOTE/$DEPLOY_BRANCH")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "$LOG_PREFIX no changes on $DEPLOY_REMOTE/$DEPLOY_BRANCH."
  exit 0
fi

if [ "$LOCAL_SHA" != "$BASE_SHA" ]; then
  echo "$LOG_PREFIX local branch diverged from $DEPLOY_REMOTE/$DEPLOY_BRANCH, skipping."
  exit 1
fi

PREV_SHA="$LOCAL_SHA"
echo "$LOG_PREFIX updating repository from $PREV_SHA to $REMOTE_SHA..."
git pull --ff-only "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"
NEW_SHA="$(git rev-parse HEAD)"

CHANGED_FILES="$(git diff --name-only "$PREV_SHA" "$NEW_SHA" || true)"
echo "$LOG_PREFIX changed files:"
echo "$CHANGED_FILES"

COMPOSE_CMD=(docker compose)
if [ -f ".env.traefik" ] && [ -f "docker-compose.traefik.yml" ]; then
  COMPOSE_CMD+=(--env-file .env.traefik -f docker-compose.yml -f docker-compose.traefik.yml)
else
  COMPOSE_CMD+=(-f docker-compose.yml)
fi

echo "$LOG_PREFIX rebuilding and updating containers..."
"${COMPOSE_CMD[@]}" up -d --build --remove-orphans

if echo "$CHANGED_FILES" | grep -qE '^backend-smg-system/prisma/(migrations/|schema\.prisma$)'; then
  echo "$LOG_PREFIX prisma change detected, running migrations..."
  "${COMPOSE_CMD[@]}" exec -T backend npx prisma migrate deploy
else
  echo "$LOG_PREFIX no prisma migration changes detected, skipping migrate deploy."
fi

echo "$LOG_PREFIX done. current sha: $NEW_SHA"
