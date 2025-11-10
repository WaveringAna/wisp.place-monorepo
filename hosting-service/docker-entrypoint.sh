#!/bin/sh
set -e

# Run different modes based on MODE environment variable
# Modes:
#   - server (default): Start the hosting service
#   - backfill: Run cache backfill and exit
#   - backfill-server: Run cache backfill, then start the server

MODE="${MODE:-server}"

case "$MODE" in
  backfill)
    echo "🔄 Running in backfill-only mode..."
    exec npm run backfill
    ;;
  backfill-server)
    echo "🔄 Running backfill, then starting server..."
    npm run backfill
    echo "✅ Backfill complete, starting server..."
    exec npm run start
    ;;
  server)
    echo "🚀 Starting server..."
    exec npm run start
    ;;
  *)
    echo "❌ Unknown MODE: $MODE"
    echo "Valid modes: server, backfill, backfill-server"
    exit 1
    ;;
esac
