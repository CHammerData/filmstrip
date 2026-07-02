#!/usr/bin/env bash
#
# One-time (idempotent) setup for the local dev stack that docker-compose.dev.yml can't express:
#   1. finish Jellyfin's first-run wizard (create an admin user)
#   2. create a Radarr root folder
#   3. seed filmstrip's Settings (pointed at the compose Jellyfin + Radarr) and a demo list
#
# Prereq:  docker compose -f docker-compose.dev.yml up -d --build
# Run:     bash scripts/dev-setup.sh          (Windows: use Git Bash)
# Re-run:  safe — each step checks current state first.
#
# Overridable via env: JF_USER, JF_PASS, LIST_URL.
set -euo pipefail

# Stop Git Bash (MSYS) from rewriting container-absolute paths like /movies into Windows paths.
export MSYS_NO_PATHCONV=1

COMPOSE="docker compose -f docker-compose.dev.yml"
JF="http://localhost:8096"
RADARR="http://localhost:7878"
JF_USER="${JF_USER:-admin}"
JF_PASS="${JF_PASS:-DemoPass123!}"
LIST_URL="${LIST_URL:-https://letterboxd.com/dave/list/official-top-250-narrative-feature-films/}"

# Single source of truth for the Radarr key: read it back from the running container.
RADARR_KEY="$($COMPOSE exec -T radarr printenv RADARR__AUTH__APIKEY | tr -d '\r\n')"

echo "==> Waiting for Radarr..."
until curl -sf "$RADARR/ping" >/dev/null 2>&1; do sleep 2; done
if [ "$(curl -s -H "X-Api-Key: $RADARR_KEY" "$RADARR/api/v3/rootfolder")" = "[]" ]; then
  echo "    creating /movies root folder"
  $COMPOSE exec -T radarr mkdir -p /movies
  $COMPOSE exec -T radarr chmod 777 /movies
  curl -sf -X POST -H "X-Api-Key: $RADARR_KEY" -H "Content-Type: application/json" \
    -d '{"path":"/movies"}' "$RADARR/api/v3/rootfolder" >/dev/null
else
  echo "    root folder already configured"
fi

echo "==> Waiting for Jellyfin..."
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$JF/System/Info/Public")" = "200" ]; do sleep 2; done
if curl -s "$JF/System/Info/Public" | grep -q '"StartupWizardCompleted":false'; then
  echo "    running first-run wizard (admin user '$JF_USER')"
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$JF/Startup/Configuration")" = "200" ]; do sleep 2; done
  curl -sf -X POST "$JF/Startup/Configuration" -H "Content-Type: application/json" \
    -d '{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}' >/dev/null
  curl -sf -X POST "$JF/Startup/RemoteAccess" -H "Content-Type: application/json" \
    -d '{"EnableRemoteAccess":false,"EnableAutomaticPortMapping":false}' >/dev/null
  # These GETs are required: Jellyfin 404s POST /Startup/User otherwise (undocumented quirk).
  curl -s "$JF/Startup/Configuration" >/dev/null
  curl -s "$JF/Startup/FirstUser" >/dev/null
  curl -s "$JF/Startup/User" >/dev/null
  curl -sf -X POST "$JF/Startup/User" -H "Content-Type: application/json" \
    -d "{\"Name\":\"$JF_USER\",\"Password\":\"$JF_PASS\"}" >/dev/null
  curl -sf -X POST "$JF/Startup/Complete" >/dev/null
else
  echo "    wizard already completed; leaving Jellyfin as-is"
fi

echo "==> Seeding filmstrip (Settings + a demo list; dry-run ON — toggle it off in Settings)"
$COMPOSE exec -T \
  -e JELLYFIN_URL=http://jellyfin:8096 \
  -e RADARR_API_URL=http://radarr:7878 \
  -e RADARR_API_KEY="$RADARR_KEY" \
  -e RADARR_QUALITY_PROFILE=HD-1080p \
  -e DRY_RUN=true \
  -e SEED_USER_NAME=Chris -e SEED_USER_TAG=chris \
  -e LETTERBOXD_URL="$LIST_URL" -e SEED_LIST_LABEL="Demo list" \
  filmstrip node dist/db/seed.js

echo
echo "Ready: http://localhost:3000  (log in with Jellyfin account  $JF_USER / $JF_PASS)"
