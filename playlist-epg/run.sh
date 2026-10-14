#!/usr/bin/env bash
# Updates the code and the iptv-org database, then builds the guide.
# Started by epg-playlist.service, but can also be run by hand.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ -f /etc/epg-playlist/epg.env && -z "${EPG_ENV_LOADED:-}" ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/epg-playlist/epg.env
  set +a
fi
export EPG_ENV_LOADED=1

EPG_DATA_DIR="${EPG_DATA_DIR:-$REPO_DIR/playlist-epg}"
EPG_PLAYLISTS="${EPG_PLAYLISTS:-$REPO_DIR/playlist-epg/playlists.txt}"
EPG_OVERRIDES="${EPG_OVERRIDES:-$REPO_DIR/playlist-epg/overrides.channels.xml}"
EPG_AUTO_UPDATE="${EPG_AUTO_UPDATE:-1}"
EPG_ARGS="${EPG_ARGS:---days=3}"

log() { echo "[$(date '+%F %T')] $*"; }

mkdir -p "$EPG_DATA_DIR/public" "$EPG_DATA_DIR/work"

# only one run at a time
exec 9>"$EPG_DATA_DIR/.lock"
if ! flock -n 9; then
  log "another run is still in progress, skipping"
  exit 0
fi

# 1. update the code (site scrapers break and get fixed upstream all the time)
if [[ "$EPG_AUTO_UPDATE" == "1" && -d .git && -z "${EPG_UPDATED:-}" ]]; then
  branch="${EPG_GIT_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
  log "updating code from origin/$branch..."
  if git fetch --quiet origin "$branch"; then
    if [[ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]]; then
      # a hard reset, because some upstream files show up as modified after checkout (line endings)
      git reset --quiet --hard FETCH_HEAD
      log "updated to $(git rev-parse --short HEAD), restarting with the new code"
      exec 9>&-
      EPG_UPDATED=1 exec "$REPO_DIR/playlist-epg/run.sh"
    fi
  else
    log "WARNING: git fetch failed, continuing with the current code"
  fi
fi

# 2. dependencies (only when package-lock.json changed)
lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -d node_modules || "$(cat node_modules/.lock-hash 2>/dev/null)" != "$lock_hash" ]]; then
  log "installing dependencies..."
  npm ci --no-audit --no-fund --ignore-scripts
  echo "$lock_hash" > node_modules/.lock-hash
fi

# 3. iptv-org database (channel names, feeds, logos)
log "downloading iptv-org database..."
if ! npm run --silent api:load > /dev/null; then
  log "WARNING: could not download the database, using the previous copy"
fi

# 4. the guide
log "building guide..."
# shellcheck disable=SC2086
npm run --silent playlist:epg -- \
  --playlists="$EPG_PLAYLISTS" \
  --overrides="$EPG_OVERRIDES" \
  --output="$EPG_DATA_DIR/public" \
  --workdir="$EPG_DATA_DIR/work" \
  $EPG_ARGS

log "finished, guide is in $EPG_DATA_DIR/public"
