#!/bin/sh
set -e

# Run different modes based on MODE environment variable
# Modes:
#   - server (default): Start the hosting service

MODE="${MODE:-server}"

case "$MODE" in
  server)
    echo "🚀 Starting server..."
    exec npm run start
    ;;
  *)
    echo "❌ Unknown MODE: $MODE"
    echo "Valid modes: server"
    exit 1
    ;;
esac
