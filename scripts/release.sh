#!/bin/bash
set -euo pipefail

# Swarm DAO Release Script
# Usage: ./scripts/release.sh [patch|minor|major]

VERSION_TYPE="${1:-patch}"
echo "🚀 Releasing Swarm DAO ($VERSION_TYPE)..."

# Ensure clean working directory
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Working directory is not clean. Commit or stash changes first."
  exit 1
fi

# Run tests
echo "🧪 Running tests..."
bun test

# Type check all packages
echo "🔍 Type checking..."
cd packages/core && npx tsc --noEmit && cd ../..
cd packages/pi-adapter && npx tsc --noEmit && cd ../..
cd packages/opencode-adapter && npx tsc --noEmit && cd ../..
cd packages/cli && npx tsc --noEmit && cd ../..

# Version bump (manual for now - could use changeset)
echo "📦 Version bump ($VERSION_TYPE)..."
echo "Update version in each package.json manually, then:"
echo "  git add ."
echo "  git commit -m 'chore: release vX.Y.Z'"
echo "  git tag vX.Y.Z"
echo "  git push origin main --tags"

echo "✅ Release preparation complete!"