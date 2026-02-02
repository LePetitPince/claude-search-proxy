# claude-search-proxy 🔍

[![CI](https://github.com/LePetitPince/claude-search-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/LePetitPince/claude-search-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**You don't need to pay for a search API to give your [OpenClaw](https://github.com/openclaw/openclaw) agent web search.** Your Claude subscription already includes it — this proxy lets you actually use it.

```bash
npm install -g claude-search-proxy
claude-search-proxy
# → Search API running on localhost:52480
```

```bash
curl -X POST http://localhost:52480/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"latest AI news"}]}'
```

That's it. OpenAI-compatible search endpoint, zero extra cost, zero dependencies.

---

## The Problem

If you're building with AI, you're probably paying for search separately — Perplexity, Brave, SerpAPI, or OpenRouter credits. But any Claude subscription (**Pro**, **Max**, **Teams**, or **Enterprise**) already includes web search through Claude Code. There's just no API for it.

This proxy creates that API. It wraps `claude -p --allowedTools WebSearch` in an OpenAI-compatible HTTP endpoint. Your tools don't know the difference — they see a standard `/v1/chat/completions` endpoint that returns search results with citations.

## Quick Start

```bash
# Install Claude CLI and authenticate
npm install -g @anthropic-ai/claude-code
claude auth login

# Install and run
npm install -g claude-search-proxy
claude-search-proxy
```

## OpenClaw Integration

Ships with a managed extension — the proxy starts and stops with your gateway automatically.

```bash
# Install the extension
openclaw plugins install --link $(npm root -g)/claude-search-proxy
```

Add to your `openclaw.json`:

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          baseUrl: "http://127.0.0.1:52480",
          apiKey: "not-needed"
        }
      }
    }
  }
}
```

Restart the gateway. `web_search` now routes through your Claude subscription.

> **Why `provider: "perplexity"`?** The proxy speaks the same OpenAI-compatible protocol. No native provider exists yet, so we reuse the Perplexity config path. Works seamlessly.

## General Usage

Works with anything that speaks OpenAI's chat completions format — LangChain, LlamaIndex, custom agents, or plain curl.

Point your client at `http://localhost:52480` with `apiKey: "not-needed"`:

```json
{
  "choices": [{ "message": { "role": "assistant", "content": "..." } }],
  "citations": ["https://...", "https://..."]
}
```

## How It Works

```
Your app → POST /v1/chat/completions → claude-search-proxy
  → claude -p "query" --allowedTools WebSearch
  → extracts citations
  → returns OpenAI-shaped JSON
```

Sessions are reused for prompt caching, then rotated after N queries to keep context bounded. Zero runtime dependencies — just Node.js built-ins.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `52480` | Port to listen on |
| `--host` | `127.0.0.1` | Host to bind to |
| `--model` | `claude-sonnet-4-20250514` | Claude model for searches |
| `--max-session-searches` | `20` | Searches per session before rotation |
| `--timeout` | `60000` | CLI timeout (ms) |
| `--verbose` | off | Debug logging |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Search (OpenAI format) |
| `POST` | `/chat/completions` | Same, without `/v1` prefix |
| `GET` | `/health` | Status + session info |

## Security

Localhost-only by default. No authentication — designed to run on your machine, not the internet.

**Protected against:** shell injection (spawn, not exec), CLI flag injection (model name validation), DNS rebinding (Host header checks), oversized requests (body + query limits), CORS (localhost origins only).

**Be aware:** searches consume your plan's token allowance. Monitor usage on your [Claude dashboard](https://claude.ai). Never bind to `0.0.0.0` without understanding the implications.

## Requirements

- **Node.js ≥ 18**
- **Claude CLI** installed and authenticated with any paid Claude plan
- Zero runtime dependencies

## Development

```bash
git clone https://github.com/LePetitPince/claude-search-proxy.git
cd claude-search-proxy
npm install
npm run build
npm test             # 49 tests, no network calls
```

## License

MIT

---

*Built by [LePetitPince](https://github.com/LePetitPince) 🌹*
