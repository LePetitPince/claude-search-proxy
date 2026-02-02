# Contributing to claude-search-proxy

Thanks for your interest. This project is small on purpose — a focused proxy that turns Claude's WebSearch into an OpenAI-compatible endpoint. Contributions that keep it focused are welcome.

## Quick Start

Bug fix or docs improvement? Just open a PR. No issue required.

```bash
git clone https://github.com/LePetitPince/claude-search-proxy.git
cd claude-search-proxy
npm install
npm run build
npm test
```

All 51 tests should pass. No network calls, no Claude CLI needed for testing.

## Development Setup

**Requirements:**
- Node.js ≥ 18
- npm
- TypeScript knowledge (the entire codebase is ~500 lines)

```bash
# Install dependencies
npm install

# Build TypeScript → JavaScript
npm run build

# Run tests (builds test config first, then runs with node:test)
npm test

# Start the proxy locally (needs Claude CLI authenticated)
npm start
```

There are no linters or formatters configured yet — match the style of surrounding code.

## Architecture

Six source files. That's it.

```
src/
├── index.ts      # CLI entry point, arg parsing, startup
├── server.ts     # HTTP server, routing, request handling
├── claude.ts     # Claude CLI execution (spawn, parse output)
├── session.ts    # Session pool (create, reuse, rotate)
├── format.ts     # Response shaping (Claude output → OpenAI JSON)
└── types.ts      # TypeScript interfaces
```

**The flow:** HTTP request → `server.ts` extracts the query → `session.ts` picks a session → `claude.ts` spawns the CLI → `format.ts` shapes the response → HTTP response.

**Key design constraints:**
- Zero runtime dependencies (only Node.js built-ins)
- Localhost-only by default
- Sequential request processing (one Claude CLI call at a time)
- Session rotation after N searches for bounded context

Read `DESIGN.md` for the full architecture and decision rationale.

## What We're Looking For

### ✅ Always Welcome
- **Bug fixes** — especially edge cases in response parsing or session management
- **Test coverage** — we use Node.js built-in test runner (`node:test`), no frameworks
- **Documentation** — README clarity, inline code comments, examples
- **Error handling** — better error messages, graceful failure modes
- **Security hardening** — input validation, defense-in-depth

### 🗣️ Open an Issue First
- **New endpoints** — the API surface is intentionally minimal
- **New CLI flags** — each flag is a maintenance commitment
- **Dependency additions** — zero-dep is a feature, not a constraint to work around
- **Behavioral changes** — anything that changes the response format or default behavior

### ⛔ Out of Scope
- Streaming support (design decision — stateless request/response only)
- Authentication/multi-user (this is a localhost sidecar)
- Support for non-Claude search backends
- Web UI or dashboard

When in doubt, open an issue and ask.

## Testing

Tests live in `test/` and use Node.js built-in `node:test` with `assert`.

```bash
# Build and run all tests
npm test

# Run a single test file
npx tsc -p tsconfig.test.json && node --test dist/test/format.test.js
```

**Test expectations:**
- Every bug fix needs a regression test
- New features need unit tests at minimum
- Tests must not make network calls or require Claude CLI
- Mock the CLI layer for integration tests (see `test/claude.test.ts` for examples)

**Current test map:**

| File | Tests | What It Covers |
|------|-------|----------------|
| `format.test.ts` | Response shaping, citation extraction, edge cases |
| `session.test.ts` | Session creation, rotation, lifecycle |
| `server.test.ts` | HTTP routing, request validation, error responses |
| `claude.test.ts` | CLI spawning, output parsing, timeout handling |

## Code Style

No automated formatter yet. Follow what's already there:

- 2-space indentation
- Single quotes for strings
- Explicit return types on exported functions
- Descriptive variable names over comments
- Group imports: Node.js built-ins first, then local modules
- No `any` — use proper types or `unknown` with narrowing

## Pull Request Process

1. **Fork and branch** — branch from `main`, name it `fix/thing` or `feat/thing`
2. **Keep it focused** — one logical change per PR. Don't mix refactors with features.
3. **Tests pass** — `npm test` must pass. Add tests for your change.
4. **Describe what and why** — the PR description should explain the problem and your approach. Link to an issue if one exists.
5. **Small PRs merge faster** — under 200 lines changed is ideal.

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
fix: handle empty WebSearch response without crashing
feat: add --quiet flag to suppress startup banner
docs: clarify OpenClaw integration steps
test: add coverage for session rotation edge case
```

## AI-Assisted Contributions

**We welcome contributions made with AI coding assistants** — Claude Code, GitHub Copilot, Cursor, Codex, whatever your tool of choice is.

### Transparency

If AI generated a significant portion of your PR, mention it. Not because there's a stigma — because it helps reviewers:

- AI-generated code sometimes has subtle issues that benefit from knowing the context
- It helps us understand which parts of the codebase are easy/hard for AI to work with
- It's honest, and honesty builds trust

A simple note in your PR description is enough:
> "Used Claude Code to scaffold the tests, then manually verified and adjusted."

### For AI Coding Agents

If you're an AI agent contributing to this project, here's what you need to know:

**Safe to do without asking:**
- Fix typos, broken links, or documentation gaps
- Add test cases for uncovered code paths
- Improve error messages
- Fix issues tagged `good-first-issue`

**Discuss first (open an issue):**
- Anything that changes the public API
- Adding CLI flags or endpoints
- Architectural changes
- Changes to the response format

**Contribution boundaries:**

```yaml
# .github/agent-contrib.yml (machine-readable)
safe_without_issue:
  - docs/**
  - test/**
  - "*.md"
  - type: bugfix
    condition: has_regression_test

needs_issue:
  - src/**
    condition: changes_public_api
  - package.json
    condition: adds_dependency

never_automate:
  - releases
  - security_fixes
  - LICENSE changes
```

**Development commands (copy-paste ready):**

```bash
# Setup
git clone https://github.com/LePetitPince/claude-search-proxy.git
cd claude-search-proxy
npm install

# Verify before submitting
npm run build          # TypeScript compilation (must succeed)
npm test               # All tests (must pass)

# Submit
git add -A
git commit -m "fix: <description>"
git push origin <branch>
gh pr create --fill    # Uses PR template if available
```

**Quality checklist (verify all before submitting):**
- [ ] `npm run build` compiles without errors
- [ ] `npm test` passes (51+ tests)
- [ ] No new runtime dependencies added
- [ ] Changes match existing code style
- [ ] PR description explains what and why

**What NOT to do:**
- Don't reformat files you didn't change
- Don't add dependencies without discussion
- Don't change default behavior without an issue
- Don't submit untested code

## Project Scope

This proxy does one thing: translate between OpenAI's chat completions format and Claude CLI's WebSearch tool. That focus is deliberate. Features that widen the scope need strong justification.

**The zero-dependency constraint is real.** If your change requires `npm install something`, it needs an issue and a compelling argument. Node.js built-ins cover a lot — use them.

## Questions?

- **Issues:** [github.com/LePetitPince/claude-search-proxy/issues](https://github.com/LePetitPince/claude-search-proxy/issues)
- **OpenClaw Discord:** [discord.com/invite/clawd](https://discord.com/invite/clawd)

---

*This project is maintained by [LePetitPince](https://github.com/LePetitPince). Built with 🌹 and zero dependencies.*
