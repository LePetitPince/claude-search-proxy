# claude-search-proxy 🔍

Turn your Claude Max subscription into a search API. Zero extra cost.

A tiny HTTP proxy that wraps Claude CLI's built-in WebSearch tool and speaks OpenAI's `/v1/chat/completions` format. Drop it in wherever you'd use Perplexity Sonar — [OpenClaw](https://github.com/openclaw/openclaw), LangChain, or anything that talks to OpenAI-shaped endpoints.

## Why

Claude Max ($200/mo) includes WebSearch at no additional charge. But the OAuth tokens don't work with the Anthropic Messages API directly. This proxy bridges the gap: it shells out to `claude -p` (which handles OAuth internally) and returns search results in a format your tools already understand.

**You get:** web search for your agent, no extra API keys or billing, using a subscription you're already paying for. Searches consume your Max plan's monthly token allowance — but you're not paying per-search on top of it.

## Quick Start

```bash
# Prerequisites: Node.js ≥ 18, Claude CLI installed and authenticated
npx claude-search-proxy
```

That's it. Server starts on `localhost:52480`.

## Usage

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

## OpenClaw Integration

```yaml
tools:
  web:
    search:
      provider: perplexity
      perplexity:
        baseUrl: "http://localhost:52480"
        apiKey: "not-needed"
```

Now `web_search` uses your Max subscription instead of burning Perplexity credits.

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
npm test             # 38 tests, no network calls
npm start            # run the server
```

## License

MIT

---

*Built by [LePetitPince](https://github.com/LePetitPince). Works with [OpenClaw](https://github.com/openclaw/openclaw) and anything that speaks OpenAI's format.* 🌹
