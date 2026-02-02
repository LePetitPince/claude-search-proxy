# claude-search-proxy 🔍

Turn your Claude Max subscription into a search API. Zero extra cost.

A tiny HTTP proxy that wraps Claude CLI's built-in WebSearch tool and speaks OpenAI's `/v1/chat/completions` format. Drop it into [OpenClaw](https://github.com/openclaw/openclaw), LangChain, or anything that talks to OpenAI-shaped endpoints — replace Perplexity, Brave, or whatever you're currently paying for with search you already have.

## Why

Claude Max ($200/mo) includes WebSearch at no additional charge. But the OAuth tokens don't work with the Anthropic Messages API directly. This proxy bridges the gap: it shells out to `claude -p` (which handles OAuth internally) and returns search results in a format your tools already understand.

**You get:** web search for your agent, no extra API keys or billing, using a subscription you're already paying for. Searches consume your Max plan's monthly token allowance — but you're not paying per-search on top of it.

## OpenClaw Setup

### Prerequisites

```bash
# Install Claude CLI and authenticate with your Max subscription
npm install -g @anthropic-ai/claude-code
claude auth login

# Install claude-search-proxy globally
npm install -g claude-search-proxy
```

### Install the Extension

The proxy ships with an OpenClaw extension that manages everything — starts with the gateway, stops on shutdown, health-monitored.

```bash
# Install and enable the extension
openclaw plugins install --link $(npm root -g)/claude-search-proxy/extension
```

Add the search config to your `openclaw.json`:

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          baseUrl: "http://localhost:52480",
          apiKey: "not-needed"
        }
      }
    }
  }
}
```

Restart the gateway. That's it — `web_search` now routes through Claude WebSearch.

> **Why `provider: "perplexity"`?** OpenClaw doesn't have a native `claude-search-proxy` provider yet. The proxy speaks the same OpenAI-compatible protocol as Perplexity Sonar, so we piggyback on that config path. It works seamlessly.

### Verify

```bash
curl http://localhost:52480/health
```

## Standalone Usage

Don't use OpenClaw? The proxy works with anything that speaks OpenAI's chat completions format.

```bash
# Start the proxy
npx claude-search-proxy
```

Server starts on `localhost:52480`. Send search queries:

```bash
curl -X POST http://localhost:52480/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "latest humanoid robot news 2026"}]}'
```

Response:
```json
{
  "choices": [{ "message": { "role": "assistant", "content": "..." } }],
  "citations": ["https://...", "https://..."]
}
```

Point any OpenAI-compatible client at `http://localhost:52480` with `apiKey: "not-needed"`.

## Options

```
--port <number>              Port to listen on (default: 52480)
--host <string>              Host to bind to (default: 127.0.0.1)
--model <string>             Claude model for searches (default: claude-sonnet-4-20250514)
--max-session-searches <n>   Searches per session before rotation (default: 20)
--timeout <ms>               CLI timeout in milliseconds (default: 60000)
--verbose                    Debug logging to stderr
```

## How It Works

```
Your app → POST /v1/chat/completions → claude-search-proxy
  → claude -p "query" --allowedTools WebSearch
  → extracts citations from response
  → returns OpenAI-shaped JSON with citations[] array
```

Sessions are reused for prompt caching (faster subsequent searches), then rotated after N queries to keep context bounded.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Search (OpenAI format) |
| POST | `/chat/completions` | Same, without `/v1` prefix |
| GET | `/health` | Status + session info |

## Security

This proxy binds to **localhost only** by default. It has no authentication — anything that can reach the port can make searches.

**What's protected:**
- `child_process.spawn` (not `exec`) — no shell injection possible
- Model name validation — prevents CLI flag injection
- Host header validation — blocks [DNS rebinding](https://en.wikipedia.org/wiki/DNS_rebinding) attacks
- CORS restricted to localhost origins
- Request body and query length limits

**What to be aware of:**
- Searches consume your **Claude Max monthly token allowance**. If the calling agent gets prompt-injected, an attacker could burn through tokens via search queries. Monitor usage on your [Claude dashboard](https://claude.ai).
- Session files in `~/.claude/` contain search history. Protect them like any credential file.
- **Never bind to `0.0.0.0`** unless you understand the implications — there's no auth layer.

## Requirements

- **Node.js ≥ 18**
- **Claude CLI** installed and authenticated with a Max subscription
- That's the whole list. Zero runtime dependencies.

## Development

```bash
git clone https://github.com/LePetitPince/claude-search-proxy.git
cd claude-search-proxy
npm install
npm run build        # compile TypeScript
npm test             # 49 tests, no network calls
npm start            # run the server
```

## License

MIT

---

*Built by [LePetitPince](https://github.com/LePetitPince) 🌹*
