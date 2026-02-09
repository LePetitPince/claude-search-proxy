# claude-search-proxy 🔍

[![npm](https://img.shields.io/npm/v/claude-search-proxy)](https://www.npmjs.com/package/claude-search-proxy)
[![CI](https://github.com/LePetitPince/claude-search-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/LePetitPince/claude-search-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**You don't need to pay for a search API to give your [OpenClaw](https://github.com/openclaw/openclaw) agent web search.** Your Claude subscription already includes it — this proxy lets you actually use it.

```bash
npm install -g claude-search-proxy
claude-search-proxy
# → Search API running on http://127.0.0.1:52480
```

```bash
curl -X POST http://127.0.0.1:52480/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"latest AI news"}]}'
```

That's it. OpenAI-compatible search endpoint, zero extra cost, zero runtime dependencies.

---

## The Problem

If you're building with AI, you're probably paying for search separately — Perplexity, Brave, SerpAPI, or OpenRouter credits. But any Claude subscription (**Pro**, **Max**, **Teams**, or **Enterprise**) already includes web search through Claude Code. There's just no API for it.

This proxy creates that API. It wraps `claude -p --allowedTools WebSearch` in an OpenAI-compatible HTTP endpoint. Your tools don't know the difference — they see a standard `/v1/chat/completions` endpoint that returns search results with citations.

## Prerequisites

```bash
# 1. Install Claude CLI
npm install -g @anthropic-ai/claude-code

# 2. Authenticate (opens browser)
claude auth login

# 3. Verify it works
echo "ping" | claude -p --allowedTools WebSearch --output-format json
```

If step 3 returns JSON, you're good.

## Install

```bash
npm install -g claude-search-proxy
```

## OpenClaw Integration

Ships with a managed extension — the proxy starts and stops with your gateway automatically. No systemd, no screen sessions.

### Step 1: Link the extension

```bash
openclaw plugins install --link $(npm root -g)/claude-search-proxy/extension
```

### Step 2: Configure search

Add to your `openclaw.json` (or use `openclaw config patch`):

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "perplexity",
        "timeoutSeconds": 90,
        "perplexity": {
          "baseUrl": "http://127.0.0.1:52480",
          "apiKey": "not-needed"
        }
      }
    }
  }
}
```

Or patch it in one command:

```bash
openclaw config patch '{
  "tools": {
    "web": {
      "search": {
        "provider": "perplexity",
        "timeoutSeconds": 90,
        "perplexity": {
          "baseUrl": "http://127.0.0.1:52480",
          "apiKey": "not-needed"
        }
      }
    }
  }
}'
```

### Step 3: Restart

```bash
openclaw gateway restart
```

The `web_search` tool now routes through your Claude subscription.

### Important notes

- **Use `127.0.0.1`, not `localhost`** — Node.js may resolve `localhost` to `::1` (IPv6), but the proxy binds to IPv4 only. Using the IP directly avoids the mismatch.
- **`timeoutSeconds: 90` is recommended** — The default (30s) is tuned for Perplexity/Brave APIs that respond in 2-5s. The Claude CLI can take 30-60s on the first search of a session (session creation + web search). After warm-up, responses are typically 5-15s.
- **Why `provider: "perplexity"`?** — The proxy speaks the same OpenAI-compatible protocol. No native provider exists yet, so we reuse the Perplexity config path. Works seamlessly.

### Verify it's working

```bash
# Check the proxy is running
curl -s http://127.0.0.1:52480/health | jq .

# Test a search
curl -s -X POST http://127.0.0.1:52480/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test search"}]}'
```

### Uninstall

```bash
# Remove config
openclaw config patch '{
  "tools": { "web": { "search": {} } },
  "plugins": {
    "entries": { "claude-search-proxy": null },
    "installs": { "claude-search-proxy": null },
    "load": { "paths": [] }
  }
}'

# Remove package
sudo npm rm -g claude-search-proxy

# Restart
openclaw gateway restart
```

## Standalone Usage

Works with anything that speaks OpenAI's chat completions format — LangChain, LlamaIndex, custom agents, or plain curl.

```bash
# Start the proxy
claude-search-proxy

# In another terminal
curl -s -X POST http://127.0.0.1:52480/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"latest AI news"}]}'
```

Response format:

```json
{
  "id": "search-...",
  "object": "chat.completion",
  "choices": [{ "message": { "role": "assistant", "content": "..." } }],
  "citations": ["https://...", "https://..."]
}
```

## Running as a Service (systemd)

For always-on setups (servers, headless machines, AI agent hosts), run the proxy as a systemd user service so it starts on boot and restarts on failure.

```bash
# Copy the sample unit file
mkdir -p ~/.config/systemd/user
cp contrib/claude-search-proxy.service ~/.config/systemd/user/

# Or if installed globally via npm:
cp $(npm root -g)/claude-search-proxy/contrib/claude-search-proxy.service \
   ~/.config/systemd/user/

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now claude-search-proxy
```

Check status and logs:

```bash
systemctl --user status claude-search-proxy
journalctl --user -u claude-search-proxy -f
```

The sample unit uses `Restart=on-failure` with a 5-second cooldown. Adjust `ExecStart` flags in the unit file to change port, timeout, or model.

> **Note:** User services require an active login session by default. To keep the service running after logout, enable lingering: `loginctl enable-linger $USER`

> **PATH note:** User services may not inherit your shell's PATH. If the proxy fails to start, replace `claude-search-proxy` in ExecStart with the full path (find it with `which claude-search-proxy`).

## How It Works

```
Your app → POST /v1/chat/completions → claude-search-proxy
  → claude -p "query" --allowedTools WebSearch
  → extracts answer + citations
  → returns OpenAI-shaped JSON
```

**Session management:** Sessions are reused for prompt caching efficiency, then rotated after N queries to keep context bounded. New sessions are pre-warmed in the background before rotation, so searches stay fast.

**Warm-up:** On startup, the proxy fires a lightweight query to create the Claude session. This means the first real search is fast (~5-15s) instead of cold (~30-60s).

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `52480` | Port to listen on |
| `--host` | `127.0.0.1` | Host to bind to |
| `--model` | `claude-sonnet-4-20250514` | Claude model for searches |
| `--max-session-searches` | `20` | Searches per session before rotation |
| `--timeout` | `60000` | CLI timeout per search (ms) |
| `--verbose` | off | Debug logging |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Search (OpenAI format) |
| `POST` | `/chat/completions` | Same, without `/v1` prefix |
| `GET` | `/health` | Status + session info |

## Limitations

Be aware of these constraints before choosing this proxy:

- **Sequential requests only** — searches are queued and processed one at a time. This is a Claude CLI constraint, not a bug.
- **Cold start latency** — the first search after startup takes 30-60s (session creation + web search). Subsequent searches are 5-15s. The proxy pre-warms sessions to minimize this.
- **No streaming** — responses are returned complete, not streamed. The `stream: true` parameter is accepted but ignored.
- **Requires a paid Claude plan** — Pro, Max, Teams, or Enterprise. The free tier does not include the WebSearch tool.
- **Consumes your plan's token allowance** — each search uses Claude tokens. Monitor your usage on the [Claude dashboard](https://claude.ai).
- **Session artifacts** — Claude CLI creates session files in `~/.claude/`. The proxy cleans these up automatically on session rotation, but you may see temporary files during operation.

## Security

Localhost-only by default. No authentication — designed to run on your machine, not the internet.

**Protected against:** shell injection (spawn, not exec), CLI flag injection (model name validation), DNS rebinding (Host header checks), oversized requests (body + query limits), CORS (localhost origins only).

**Be aware:** searches consume your plan's token allowance. Monitor usage on your [Claude dashboard](https://claude.ai). Never bind to `0.0.0.0` without understanding the implications.

## Requirements

- **Node.js ≥ 18**
- **Claude CLI** (`@anthropic-ai/claude-code`) installed and authenticated
- Any paid Claude plan (Pro, Max, Teams, or Enterprise)
- Zero runtime dependencies

## Development

```bash
git clone https://github.com/LePetitPince/claude-search-proxy.git
cd claude-search-proxy
npm install
npm run build
npm test             # 91 tests, no network calls
```

## Troubleshooting

**"fetch failed" or "operation aborted"**
- Check the proxy is running: `curl http://127.0.0.1:52480/health`
- Make sure you're using `127.0.0.1` not `localhost` in your config
- Increase `timeoutSeconds` to 90+ if the first search times out

**Proxy starts but searches hang**
- Verify Claude CLI is authenticated: `claude auth status`
- Test the CLI directly: `echo "test" | claude -p --allowedTools WebSearch`

**"EADDRINUSE"**
- Another instance is running on that port. Kill it or use `--port 52481`

**Searches are slow (30-60s)**
- Expected on the first search after startup (session creation). Subsequent searches should be 5-15s.
- If ALL searches are slow, the session may not be persisting. Check `--verbose` output for "Rotated" messages.

**Empty or unhelpful results**
- Claude's WebSearch may not find results for very specific or niche queries
- Try rephrasing the query — the proxy passes it directly to Claude

**Session "already in use" error in logs**
- Normal during startup — the proxy retries with fresh session IDs automatically (up to 3 attempts)
- If persistent, delete stale sessions: `rm ~/.claude/projects/*/SESSION_ID*`

## License

MIT

---

*Built by [LePetitPince](https://github.com/LePetitPince) 🌹*
