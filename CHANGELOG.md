# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial unified architecture combining pi-swarm-dao and opencode-dao
- **Core** (`@swarm-dao/core`): Pure business logic for AI agent governance
  - 4-layer architecture: Governance, Intelligence, Delivery, Control
  - 7 default specialized agents with weighted voting
  - Proposal lifecycle: open → deliberating → approved → controlled → executed
  - Composite scoring (RICE + weighted axes)
  - Quality control gates with type-specific severity
  - Self-amending DAO (agents, config, quorum, gates)
  - Audit trail with full history
  - Outcome tracking with ratings and metrics
  - Health score dashboard
- **Adapters**:
  - Pi adapter (`@swarm-dao/pi-adapter`) with 20+ tools and `/dao` command
  - OpenCode adapter (`@swarm-dao/opencode-adapter`) with 15+ tools
- **CLI** (`@swarm-dao/cli`): Standalone `swarm-dao` binary
  - `init`, `setup`, `propose`, `list`, `show`, `vote`, `config`, `audit`, `status`
- **Integrations**:
  - GitHub: create branch, open PR, sync issues
  - GitLab: create branch, open MR
  - Bitbucket: create branch, open PR
- **Artefacts**: Auto-generation of 7 document types
  - Decision Brief, ADR, Risk Report, PRD Lite
  - Implementation Plan, Test Plan, Release Packet
- **Round Table**: Agents suggest proposals automatically
- **Dry-Run / Rollback**: Preview and revert executions
- **Persistence**: `.dao/` local file store with sidecars
- **Config**: Per-project `.dao/config.json` with 3 modes (opt-in, suggest, enforce)
- **Documentation**: ADR-001, Extension Guide, README
- **CI/CD**: GitHub Actions workflow
- **Tests**: 57+ tests across core, CLI, and adapters