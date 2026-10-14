#!/usr/bin/env bash
# Sets up automatic EPG updates on Ubuntu (22.04 / 24.04).
# Run from inside the cloned repository:  sudo ./playlist-epg/install.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo $0" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-epg}"
CONFIG_DIR=/etc/epg-playlist
DATA_DIR=/var/lib/epg-playlist
NODE_MAJOR=22

echo "==> Installing packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates util-linux > /dev/null

current_node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if [[ "$(current_node_major)" -lt 20 ]]; then
  echo "==> Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> Creating user '$SERVICE_USER'"
if ! id "$SERVICE_USER" &> /dev/null; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
mkdir -p "$DATA_DIR/public" "$DATA_DIR/work"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$REPO_DIR"
# git refuses to work in a repository owned by another user unless it is marked as safe
git config --system --add safe.directory "$REPO_DIR" 2> /dev/null || true

echo "==> Writing configuration to $CONFIG_DIR (existing files are kept)"
mkdir -p "$CONFIG_DIR"
for file in playlists.txt overrides.channels.xml epg.env; do
  [[ -f "$CONFIG_DIR/$file" ]] || cp "$REPO_DIR/playlist-epg/$file" "$CONFIG_DIR/$file"
done
branch="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
sed -i "s|^EPG_GIT_BRANCH=$|EPG_GIT_BRANCH=$branch|" "$CONFIG_DIR/epg.env"

echo "==> Installing dependencies"
sudo -u "$SERVICE_USER" -H bash -c "cd '$REPO_DIR' && npm ci --no-audit --no-fund --ignore-scripts > /dev/null && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lock-hash"

echo "==> Installing systemd units"
for unit in epg-playlist.service epg-playlist.timer epg-playlist-serve.service; do
  sed -e "s|@REPO_DIR@|$REPO_DIR|g" -e "s|@USER@|$SERVICE_USER|g" \
    "$REPO_DIR/playlist-epg/systemd/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now epg-playlist.timer epg-playlist-serve.service

echo "==> Starting the first run in the background"
systemctl start --no-block epg-playlist.service

port="$(. "$CONFIG_DIR/epg.env"; echo "${EPG_PORT:-3000}")"
cat << MSG

Done.

  Follow the first run:   journalctl -u epg-playlist -f
  Guide:                  http://$(hostname -I | awk '{print $1}'):$port/guide.xml  (or guide.xml.gz)
  Report:                 http://$(hostname -I | awk '{print $1}'):$port/report.md
  Settings:               $CONFIG_DIR/epg.env
  Playlists:              $CONFIG_DIR/playlists.txt
  Manual mappings:        $CONFIG_DIR/overrides.channels.xml
  Schedule:               systemctl list-timers epg-playlist.timer

MSG
