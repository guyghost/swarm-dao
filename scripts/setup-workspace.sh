#!/usr/bin/env bash
# One-shot workspace setup: workspace links, Pi extension, optional peer stubs.
# Idempotent — safe to re-run after any `bun install`, which prunes unmanaged
# symlinks from node_modules.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '  %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; }

# link <target-relative-to-link-dir> <link-path>
link() {
    local target="$1" link_path="$2"
    mkdir -p "$(dirname "$link_path")"
    rm -rf "$link_path"
    ln -s "$target" "$link_path"
    log "$link_path → $target"
}

printf '\033[34m▸\033[0m Linking workspace packages\n'
# Bun links workspace dependencies per package, but the root scope stays empty:
# root-level `bun test` and the Pi extension both resolve through it.
link "../../packages/core" "node_modules/@guyghost/swarm-dao-core"

printf '\033[34m▸\033[0m Registering the Pi extension\n'
link "../../packages/pi-adapter/src/index.ts" ".pi/extensions/swarm-dao.ts"

printf '\033[34m▸\033[0m Creating stubs for optional peer dependencies\n'
bash "$ROOT/scripts/setup-stubs.sh"

printf '\033[34m▸\033[0m Verifying\n'
errors=0
check() {
    if [ -e "$1" ]; then
        log "ok  $1"
    else
        fail "missing $1"
        errors=$((errors + 1))
    fi
}
check "packages/core/package.json"
check "node_modules/@guyghost/swarm-dao-core/package.json"
check ".pi/extensions/swarm-dao.ts"
check "node_modules/@earendil-works/pi-ai/index.js"
check "node_modules/@earendil-works/pi-coding-agent/index.js"

if [ "$errors" -ne 0 ]; then
    fail "workspace setup incomplete ($errors problem(s)) — run \`bun install\` and retry"
    exit 1
fi

printf '\033[32m✓\033[0m Workspace ready\n'
