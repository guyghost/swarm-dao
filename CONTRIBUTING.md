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
│   ├── core/              # Business logic (host-agnostic, hexagonal core)
│   ├── mcp-server/        # Swarm DAO as a stdio MCP server
│   ├── pi-adapter/        # Pi coding agent bridge (native tool spawning)
│   ├── opencode-adapter/  # OpenCode plugin (manual dispatch)
│   ├── copilot-adapter/   # GitHub Copilot plugin (MCP + instructions)
│   ├── claude-adapter/    # Claude Code plugin (MCP + slash commands)
│   ├── codex-adapter/     # OpenAI Codex plugin (MCP + AGENTS.md)
│   └── cli/               # Standalone CLI
├── agents/                # Shared agent prompts
├── models/                # Behavioral model docs (XState workflows live in packages/core/src/models)
├── docs/                  # Documentation (ADRs, guides)
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
- [ ] Configure the npm Trusted Publisher for the new package before its first release (see [Releasing](#releasing))

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

## Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets)
and the [`publish.yml`](.github/workflows/publish.yml) workflow — **versions are
never bumped by hand.**

1. **Add a changeset** describing the change and the packages/semver to bump:
   ```bash
   bun run changeset
   ```
   Commit the generated `.changeset/*.md` alongside your change and open a PR.
2. **Merge the feature PR.** The `version` job (on `pull_request_target`) opens
   a separate `chore(release): version packages` PR on `changeset-release/main`
   with the bumped versions and changelogs.
3. **Merge the version PR.** Pushing to `main` triggers the `publish` job, which
   builds and publishes every changed package to npm with provenance.

Publishing uses **npm Trusted Publishing (OIDC)** — no `NPM_TOKEN` is stored.
Each package must have its Trusted Publisher configured on npmjs.com
(owner `guyghost`, repo `swarm-dao`, workflow `publish.yml`) **before** it can
publish through OIDC; otherwise you will see
`npm error 404 Not Found - PUT`. Packages first published manually (classic
token, no provenance) need their Trusted Publisher added before the OIDC
workflow can publish them. See the README [CI/CD](README.md#cicd) section for
setup and troubleshooting, and remember to configure a new package's Trusted
Publisher before its first release.

## Reporting Issues

Please include:
- Swarm DAO version
- Host (Pi, OpenCode, CLI, Copilot, Claude Code, Codex, or generic MCP client)
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.