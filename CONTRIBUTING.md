# Contributing to Swarm DAO

Thank you for your interest in contributing! This document will help you get started.

## Development Setup

```bash
# Clone
git clone https://github.com/guyghost/swarm-dao.git
cd swarm-dao

# Install dependencies (requires Bun >= 1.3)
bun install

# Create local type stubs for optional host SDKs (required for typecheck/build)
bun run setup-stubs

# Run tests
bun test

# Type check
bun run --filter '*' typecheck

# Run full CI locally (same gates as GitHub Actions)
bun run ci

# Fix lint/format issues
bun run lint:fix
```

## Git Hooks

After `bun install`, a **pre-push** hook runs automatically and executes `bun run ci` before every push. This mirrors the GitHub Actions workflow (lint, typecheck, test, build, pack validation).

To bypass in an emergency: `git push --no-verify` (use sparingly).

## Project Structure

```
swarm-dao/
├── packages/
│   ├── core/              # Business logic (host-agnostic)
│   ├── pi-adapter/        # Pi coding agent bridge
│   ├── opencode-adapter/  # OpenCode bridge
│   └── cli/               # Standalone CLI
├── agents/                # Shared agent prompts
├── docs/                  # Documentation
└── .github/workflows/     # CI/CD
```

## Adding a New Host Adapter

See [docs/EXTENSION-GUIDE.md](docs/EXTENSION-GUIDE.md) for detailed instructions.

Quick checklist:
- [ ] Create `packages/<host>-adapter/`
- [ ] Implement `HostAdapter` interface
- [ ] Register DAO tools with host's plugin system
- [ ] Add type stubs if host SDK isn't installable standalone
- [ ] Add tests
- [ ] Update README

## Code Style

- Use TypeScript with strict mode
- Follow existing patterns in the codebase
- Add tests for new functionality
- Update documentation for user-facing changes

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run CI locally (`bun run ci`)
5. Commit with clear messages
6. Open a PR with description of changes

## Reporting Issues

Please include:
- Swarm DAO version
- Host (Pi, OpenCode, CLI)
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.