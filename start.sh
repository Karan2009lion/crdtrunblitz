#!/usr/bin/env bash
# Builds and starts the CRDTrade BTC paper bot on this computer (macOS and Linux).
#   ./start.sh            build and start
#   ./start.sh --update   download the latest version from GitHub first
set -euo pipefail
cd "$(dirname "$0")"

PORT=4173   # keep this fixed: the browser saves the paper test per address
URL="http://localhost:$PORT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then run ./start.sh again."
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)'; then
  echo "Node.js $(node -v) is too old. Install Node.js 22 LTS from https://nodejs.org, then run ./start.sh again."
  exit 1
fi

if [ "${1:-}" = "--update" ]; then
  echo "Downloading the latest version…"
  git pull --ff-only
fi

echo "Installing…"
npm ci --no-audit --no-fund --loglevel=error
echo "Building…"
npm run build --silent

echo
echo "CRDTrade is running at $URL"
echo "Keep this window open during the test. Press Ctrl+C to stop the app."
echo
node scripts/open-when-ready.cjs "$URL" &
exec node server/index.mjs
