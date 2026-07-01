#!/usr/bin/env bash
# Bitburner dev environment launcher
# Starts: 1) Bitburner game container (Podman)  2) TypeScript filesync in tmux
set -euo pipefail

PROJECT_DIR="/home/equail/Projects/bitburner-template"
TMUX_SESSION="bitburner"

# --- 1. Start the Bitburner game container ---
if podman inspect bitburner >/dev/null 2>&1; then
  if [ "$(podman inspect -f '{{.State.Running}}' bitburner)" != "true" ]; then
    echo "Starting existing bitburner game container..."
    podman start bitburner
  else
    echo "Bitburner game container already running."
  fi
else
  echo "Building and starting bitburner game container..."
  podman run -d --name bitburner -p 8080:80 localhost/bitburner:latest
fi

echo "  → Game: http://localhost:8080"

# --- 2. Start the TypeScript filesync in tmux ---
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "tmux session '$TMUX_SESSION' already exists. Attaching..."
else
  echo "Starting tmux session '$TMUX_SESSION' for filesync..."
  tmux new-session -d -s "$TMUX_SESSION" -c "$PROJECT_DIR" "npm run watch:all"
  echo "  → Filesync: port 12525 (connect in game: Options → Remote API)"
fi

echo ""
echo "=== Bitburner dev environment ready ==="
echo "  Game:        http://localhost:8080"
echo "  Filesync:    port 12525"
echo "  Scripts:     $PROJECT_DIR/src/"
echo "  tmux:        tmux attach -t $TMUX_SESSION"
echo "  Stop game:   podman stop bitburner"
echo "  Stop tmux:   tmux kill-session -t $TMUX_SESSION"