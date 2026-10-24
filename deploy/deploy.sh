#!/usr/bin/env bash
# Ships the API, the built web app and the published data to the VM, then restarts the service.
# Usage: VM=user@host SSH_KEY=~/.ssh/key SSH_PORT=22 deploy/deploy.sh
# The VM keeps its own ~/bhatta/env (BHATTA_RELAYER_KEY lives only there); this script never sends a key.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${VM:?set VM=user@host}"
SSH_PORT="${SSH_PORT:-22}"
SSH=(ssh -p "$SSH_PORT" ${SSH_KEY:+-i "$SSH_KEY"})
RSYNC_SSH="ssh -p $SSH_PORT ${SSH_KEY:+-i $SSH_KEY}"

test -f "$ROOT/web/dist/index.html" || { echo "build the web app first: (cd web && npm run build)"; exit 1; }

"${SSH[@]}" "$VM" 'mkdir -p ~/bhatta/data ~/bhatta/docs ~/bhatta/web'
rsync -az --delete -e "$RSYNC_SSH" --exclude .venv --exclude __pycache__ --exclude tests "$ROOT/api/" "$VM:bhatta/api/"
rsync -az --delete -e "$RSYNC_SSH" "$ROOT/web/dist/" "$VM:bhatta/web/dist/"
rsync -az --delete -e "$RSYNC_SSH" \
  --include 'kilns.json' --include 'summary.json' --include 'manifest.json' --include 'chain.json' \
  --include 'eval_results.json' --include 'conformal.json' --include 'inspectors.json' \
  --include 'abi/***' --include 'merkle/***' --include 'chips/***' --include 'audit/***' --include 'fixtures/***' \
  --exclude '*' "$ROOT/data/" "$VM:bhatta/data/"
rsync -az -e "$RSYNC_SSH" "$ROOT/docs/RESULTS.md" "$ROOT/docs/PREREG.md" "$VM:bhatta/docs/"
rsync -az -e "$RSYNC_SSH" "$ROOT/deploy/bhatta.service" "$VM:bhatta/bhatta.service"

"${SSH[@]}" "$VM" bash -s <<'REMOTE'
set -euo pipefail
cd ~/bhatta
if [ ! -x .venv/bin/python ]; then ~/.local/bin/uv venv -q --python 3.12 .venv; fi
~/.local/bin/uv pip install -q --python .venv/bin/python -r api/requirements.txt
touch env && chmod 600 env
sudo cp bhatta.service /etc/systemd/system/bhatta.service
sudo systemctl daemon-reload
sudo systemctl enable -q bhatta
sudo systemctl restart bhatta
sleep 3
curl -fsS http://127.0.0.1:8418/api/health
REMOTE
