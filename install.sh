#!/bin/sh
# Engram installer. Needs nothing preinstalled (no Docker, no Node, no database):
#   curl -fsSL https://raw.githubusercontent.com/ManojRakshu/engram/main/install.sh | sh
# Pass setup flags after `sh -s --`, e.g. `| sh -s -- --agents cursor,codex`.
set -e
REPO="${ENGRAM_REPO:-https://github.com/ManojRakshu/engram}"
DEST="${ENGRAM_HOME:-$HOME/.engram}/app"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull -q --ff-only
elif command -v git >/dev/null 2>&1; then
  git clone -q --depth 1 "$REPO" "$DEST"
else
  mkdir -p "$DEST" && curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz --strip-components=1 -C "$DEST"
fi
exec "$DEST/plugin/bin/engram" setup "$@"
