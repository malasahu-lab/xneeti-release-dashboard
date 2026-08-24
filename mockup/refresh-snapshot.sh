#!/bin/sh
# Refresh the offline snapshot from the live release log.
# Only needed before a demo on unreliable wifi — the pages fetch live by default.
set -e
cd "$(dirname "$0")"
{
  printf '// Offline snapshot. Only used if the live fetch fails (e.g. demo wifi dies).\n'
  printf '// Regenerate with: ./refresh-snapshot.sh\n'
  printf 'window.RELEASES_FALLBACK = '
  curl -fsS https://malasahu-lab.github.io/xneeti-release-dashboard/releases.json \
    | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["releases"], separators=(",",":")), end="")'
  printf ';\n'
} > data-fallback.js.tmp
mv data-fallback.js.tmp data-fallback.js
echo "snapshot refreshed: $(grep -o '"id"' data-fallback.js | wc -l | tr -d ' ') releases"
