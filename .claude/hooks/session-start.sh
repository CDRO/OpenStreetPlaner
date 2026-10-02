#!/bin/bash
# SessionStart-Hook für Claude Code im Web: stellt nctl (Deploio-CLI) bereit, damit die
# Deploio-Skills unter .claude/skills/ deployen können. Läuft nur in der Cloud-Umgebung,
# ist idempotent und bricht die Sitzung nie ab (fehlendes Netz => Hinweis statt Fehler).
#
# Voraussetzungen in den Umgebungseinstellungen (Netzwerk):
#   github.com + objects.githubusercontent.com (Release-Download) oder repo.nine.ch (apt),
#   dazu nineapis.ch, auth.nine.ch und git-info.deplo.io für nctl selbst.
# Zugangsdaten als Umgebungsvariablen: NCTL_API_CLIENT_ID, NCTL_API_CLIENT_SECRET, NCTL_ORGANIZATION.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NCTL_VERSION="${NCTL_VERSION:-1.20.0}"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "${CLAUDE_ENV_FILE:-/dev/null}"
export PATH="$BIN_DIR:$PATH"

if command -v nctl >/dev/null 2>&1; then
  echo "nctl vorhanden: $(nctl --version 2>/dev/null | head -1)"
else
  tmp=$(mktemp -d)
  url="https://github.com/ninech/nctl/releases/download/v${NCTL_VERSION}/nctl_${NCTL_VERSION}_linux_amd64.tar.gz"
  if curl -fsSL --max-time 120 "$url" -o "$tmp/nctl.tar.gz" 2>/dev/null && tar -xzf "$tmp/nctl.tar.gz" -C "$tmp" 2>/dev/null; then
    bin=$(find "$tmp" -type f -name nctl | head -1)
    if [ -n "$bin" ]; then
      install -m 0755 "$bin" "$BIN_DIR/nctl"
      echo "nctl ${NCTL_VERSION} installiert nach $BIN_DIR"
    fi
  fi
  rm -rf "$tmp"
  if ! command -v nctl >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    # Zweiter Weg: apt-Repository von nine.ch (braucht Netzfreigabe für repo.nine.ch)
    echo "deb [trusted=yes] https://repo.nine.ch/deb/ /" > /etc/apt/sources.list.d/repo.nine.ch.list 2>/dev/null \
      && apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq nctl >/dev/null 2>&1 \
      && echo "nctl über repo.nine.ch installiert"
  fi
  if ! command -v nctl >/dev/null 2>&1; then
    echo "nctl konnte nicht geladen werden (Netzfreigabe für github.com/objects.githubusercontent.com oder repo.nine.ch fehlt). Deploio-Deployments sind in dieser Sitzung nicht möglich."
  fi
fi

if [ -z "${NCTL_API_CLIENT_ID:-}" ] || [ -z "${NCTL_API_CLIENT_SECRET:-}" ] || [ -z "${NCTL_ORGANIZATION:-}" ]; then
  echo "Hinweis: NCTL_API_CLIENT_ID, NCTL_API_CLIENT_SECRET und NCTL_ORGANIZATION sind nicht gesetzt – nctl kann sich nicht anmelden."
fi

# Go-Module vorab laden (Cache wird mit dem Container gesichert); Fehler sind nicht fatal.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" && go mod download >/dev/null 2>&1 || true
exit 0
