#!/usr/bin/env bash
# Install one Better Auth version for the tests (CI's matrix).
# Usage: scripts/use-better-auth.sh <version|latest-1.7|latest|next>
set -euo pipefail
want="${1:?version}"
case "$want" in
  latest-1.7) v="$(npm view 'better-auth@>=1.7.0 <1.8.0' version --json | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(Array.isArray(v)?v.at(-1):v)')" ;;
  latest|next) v="$(npm view "better-auth@$want" version)" ;;
  *) v="$want" ;;
esac
echo "better-auth $want -> $v"
pnpm add -D "better-auth@$v" "@better-auth/core@$v"
