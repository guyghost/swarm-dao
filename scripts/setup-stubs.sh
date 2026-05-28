#!/usr/bin/env bash
# Setup runtime stubs for optional peer dependencies.
# These packages are declared as optional peer dependencies in the adapters,
# but Bun needs them at test/runtime time. We create minimal stubs in node_modules.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Stub for @earendil-works/pi-ai
mkdir -p "$ROOT/node_modules/@earendil-works/pi-ai"
cat > "$ROOT/node_modules/@earendil-works/pi-ai/package.json" << 'EOF'
{
  "name": "@earendil-works/pi-ai",
  "version": "0.0.1-stub",
  "main": "./index.js",
  "type": "module"
}
EOF
cat > "$ROOT/node_modules/@earendil-works/pi-ai/index.js" << 'EOF'
export function StringEnum(values, _options) {
  return values.reduce((acc, v) => ({ ...acc, [v]: v }), {});
}
EOF

# Stub for @earendil-works/pi-coding-agent
mkdir -p "$ROOT/node_modules/@earendil-works/pi-coding-agent"
cat > "$ROOT/node_modules/@earendil-works/pi-coding-agent/package.json" << 'EOF'
{
  "name": "@earendil-works/pi-coding-agent",
  "version": "0.0.1-stub",
  "main": "./index.js",
  "type": "module"
}
EOF
cat > "$ROOT/node_modules/@earendil-works/pi-coding-agent/index.js" << 'EOF'
// This is a stub. The real package is a peer dependency.
export {};
EOF

# Stub for @opencode-ai/plugin
mkdir -p "$ROOT/node_modules/@opencode-ai/plugin"
cat > "$ROOT/node_modules/@opencode-ai/plugin/package.json" << 'EOF'
{
  "name": "@opencode-ai/plugin",
  "version": "0.0.1-stub",
  "main": "./index.js",
  "type": "module"
}
EOF
cat > "$ROOT/node_modules/@opencode-ai/plugin/index.js" << 'EOF'
// This is a stub. The real package is a peer dependency.
function createSchemaProxy() {
  const proxy = new Proxy(() => proxy, {
    get(_target, prop) {
      if (prop === 'describe') return () => proxy;
      if (prop === 'optional') return () => proxy;
      if (prop === 'default') return () => proxy;
      return proxy;
    },
    apply(_target, _thisArg, args) {
      return proxy;
    },
  });
  return proxy;
}

export function tool(input) {
  return input;
}

tool.schema = {
  string: createSchemaProxy,
  number: createSchemaProxy,
  boolean: createSchemaProxy,
  array: () => createSchemaProxy(),
  object: () => createSchemaProxy(),
  enum: () => createSchemaProxy(),
};
EOF

echo "✅ Runtime stubs created in node_modules"
