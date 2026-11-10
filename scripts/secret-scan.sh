#!/usr/bin/env bash
# Simple pre-push secret scan over tracked + staged files. Exits 1 on a hit.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
patterns=(
  'A21AA[A-Za-z0-9_-]{20,}'          # PayPal access token
  'E[A-Za-z0-9_-]{70,}'              # PayPal-style client secret (long)
  'AIza[0-9A-Za-z_-]{35}'            # Google API key
  'gh[pousr]_[A-Za-z0-9]{30,}'       # GitHub token
  '"key"\s*:\s*"[0-9a-f]{32}"'       # kaggle.json key
  'rnd_[A-Za-z0-9]{20,}'             # Render API key
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
files=$(git ls-files -c -o --exclude-standard | grep -v -E '^(package-lock\.json|node_modules/)' || true)
hit=0
for p in "${patterns[@]}"; do
  if out=$(echo "$files" | xargs -r grep -nIE -- "$p" 2>/dev/null); then
    echo "Possible secret ($p):"; echo "$out" | sed -E 's/(.{0,60}).*/\1…/'; hit=1
  fi
done
if git ls-files --error-unmatch .env >/dev/null 2>&1; then echo ".env is tracked!"; hit=1; fi
[ $hit -eq 0 ] && echo "secret scan: clean"
exit $hit
