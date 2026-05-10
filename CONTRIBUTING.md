# Contributing to Swarm DAO

Thank you for your interest in contributing! This document will help you get started.

## Development Setup

```bash
# Clone
git clone https://github.com/guyghost/swarm-dao.git
cd swarm-dao

# Install dependencies (requires Bun >= 1.3)
bun install

# Run tests
bun test

# Type check
bun run --filter '*' typecheck
```

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
4. Run tests (`bun test`)
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