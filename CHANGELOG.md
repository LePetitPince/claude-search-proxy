# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Session artifact cleanup after rotation (prevents `~/.claude/` accumulation)
- Warm-up retry logic (3 attempts with fresh UUIDs on "already in use" errors)
- systemd user service sample in `contrib/claude-search-proxy.service`
- Security and pentest test suite (DNS rebinding, CORS, injection protection)
- CHANGELOG.md
- CONTRIBUTING.md with agent-friendly contribution guide

### Changed
- README rewritten for better install-friendliness and clarity
- Documentation now consistently uses `127.0.0.1` instead of `localhost` to avoid IPv6 resolution issues

## [1.0.1] - 2026-02-02

### Fixed
- Session warm-up on startup + background pre-warming before rotation (eliminates cold-start delays)

### Changed
- Documentation updated to use `127.0.0.1` instead of `localhost` in all config examples

## [1.0.0] - 2026-02-02

### Added
- Initial public release
- OpenAI-compatible HTTP proxy wrapping Claude CLI WebSearch
- Session management with automatic rotation and request queueing
- OpenClaw extension for managed proxy lifecycle (auto-start/stop with gateway)
- CLI interface with configurable options:
  - `--port` (default: 52480)
  - `--host` (default: 127.0.0.1)
  - `--model` (default: claude-sonnet-4-20250514)
  - `--max-session-searches` (default: 20)
  - `--timeout` (default: 60000ms)
  - `--verbose` for debug logging
- Health endpoint (`GET /health`) with session and queue metrics
- Two completions endpoints:
  - `POST /v1/chat/completions` (OpenAI standard)
  - `POST /chat/completions` (without /v1 prefix)
- Response format with citations array
- Security hardening:
  - DNS rebinding protection via Host header validation
  - CORS restricted to localhost origins only
  - Request body size limits (1MB)
  - Query parameter size limits
  - Shell injection protection (validated spawn, never exec)
  - CLI flag injection protection (model name validation)
- Comprehensive test suite (91 tests, all offline):
  - Claude executor tests (result parsing, error handling, timeout)
  - Format tests (OpenAI response shaping, citation extraction)
  - Server tests (HTTP endpoints, CORS, security)
  - Session tests (rotation, queueing, race conditions)
- CI/CD pipeline with GitHub Actions
- Zero runtime dependencies (pure Node.js ≥18)
- Support for all Claude subscription tiers (Pro, Max, Teams, Enterprise)
- Detailed documentation:
  - OpenClaw integration guide
  - Standalone usage examples
  - Security considerations
  - Troubleshooting guide

[Unreleased]: https://github.com/LePetitPince/claude-search-proxy/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/LePetitPince/claude-search-proxy/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/LePetitPince/claude-search-proxy/releases/tag/v1.0.0
