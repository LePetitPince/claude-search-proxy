# claude-search-proxy — Design Document

*Created: 2026-02-02 by LePetitPince*
*Status: Pre-implementation — decisions locked with J*

## What Is This?

An OpenAI-compatible HTTP proxy that turns Claude's built-in WebSearch tool into a search API.
Drop-in replacement for Perplexity Sonar in OpenClaw (or anything that speaks the same protocol).

**Why:** Claude Max subscription ($200/mo) includes WebSearch at zero extra cost.
No Brave API key, no Perplexity API key, no OpenRouter credits. Just your Max sub.

## Critical Discovery

**OAuth tokens from Claude Max DON'T work with the Anthropic Messages API directly.**
The API returns: `"OAuth authentication is currently not supported."`

This means we MUST use Claude CLI (`claude -p`) as the execution layer.
The CLI handles OAuth + token refresh internally.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  OpenClaw (or any OpenAI-compatible client)          │
│  POST /v1/chat/completions                          │
│  { messages: [{role:"user", content:"query"}] }     │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  claude-search-proxy (HTTP server on localhost)      │
│  - Accepts OpenAI chat/completions format            │
│  - Extracts query from messages                      │
│  - Calls: claude -p "query" --allowedTools WebSearch │
│  - Formats response as OpenAI-compatible JSON        │
│  - Returns { choices, citations }                    │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│  Claude CLI (claude -p)                              │
│  - Uses Max subscription OAuth token                 │
│  - Handles auth + token refresh automatically        │
│  - Invokes WebSearch server-side tool                │
│  - Returns search results + synthesis                │
└─────────────────────────────────────────────────────┘
```

## OpenClaw Integration

```json
{
  "tools": {
    "web": {
      "search": {
        "provider": "perplexity",
        "perplexity": {
          "baseUrl": "http://localhost:3271",
          "apiKey": "not-needed",
          "model": "claude-sonnet-4-20250514"
        }
      }
    }
  }
}
```

OpenClaw's Perplexity codepath sends:
```
POST /v1/chat/completions (or /chat/completions)
{
  "model": "...",
  "messages": [{"role": "user", "content": "search query"}]
}
```

And expects back:
```json
{
  "choices": [{"message": {"content": "synthesized answer with info"}}],
  "citations": ["https://url1.com", "https://url2.com"]
}
```

That's our contract.

## Decisions (locked with J)

| Decision | Choice | Reason |
|----------|--------|--------|
| Backend | Claude CLI (`claude -p`) | OAuth tokens don't work with API directly |
| Model default | Sonnet | Good synthesis, fast. Configurable to Haiku |
| Language | TypeScript | Matches ecosystem, type safety for public project |
| Framework | Node.js built-in `http` | Zero deps beyond what we need |
| Auth | None (localhost bind) | It's a local proxy |
| License | MIT | Simplest, most permissive |
| Scope | Narrow — OpenClaw search shim | Focused value prop |
| Repo | github.com/LePetitPince/claude-search-proxy | Our first public project |
| Tests | Required before first push | Unit + integration |
| Packaging | npm (npx claude-search-proxy) | Easy install |
| README | High quality, agent-first | Our calling card |

## Session Reuse Strategy

Session reuse gives us **prompt caching** — the Anthropic API caches the prompt prefix
(system prompt + prior turns). After the first search in a session, subsequent searches
hit the cache = faster responses + less rate limit pressure on Max.

**Decision: Rotating session pool.**

```
Session lifecycle:
  1. Generate session UUID
  2. First search: claude -p "query" --session-id <uuid> --system-prompt "..."
     (cold start — system prompt fully processed)
  3. Searches 2-N: claude -p "query" --resume <uuid>
     (warm — system prompt cached, only new query processed)
  4. After N searches (default 20, configurable): discard session, start fresh
     (prevents context from growing unbounded)
```

Context growth per search: ~500-1000 tokens (query + response).
20 searches ≈ 10-15K tokens of accumulated context. Well within budget.
The caching benefit (faster responses, less rate limit burn) outweighs the context cost.

Implementation:
- `SessionManager` class tracks current session UUID + search count
- Atomic: only one search runs at a time (queue others)
- On rotation: generate new UUID, reset counter
- Configurable max searches per session via CLI flag (`--max-session-searches`)
- Old session files cleaned up on rotation

Additional optimizations:
- `--output-format json` for structured parsing
- `--model` flag to control which model does the search
- Request queuing (sequential to avoid rate limits)

## System Prompt (CLAUDE.md equivalent)

The `--system-prompt` flag will instruct the search Claude:

```
You are a search engine. When given a query:
1. Use the WebSearch tool to find current, accurate information
2. Synthesize a clear, factual summary
3. Include ALL source URLs you found
4. Be concise but thorough — the consumer is another AI agent, not a human
5. Prefer recent sources over older ones
6. If the query asks for specific data (prices, dates, stats), lead with that data
7. Format: plain text synthesis, no markdown headers
```

## Response Format

The proxy extracts URLs from Claude's WebSearch tool results and returns them as `citations[]`.
The synthesized text goes into `choices[0].message.content`.

OpenClaw's code path:
```js
const content = data.choices?.[0]?.message?.content ?? "No response";
const citations = data.citations ?? [];
return { content, citations };
```

## File Structure

```
claude-search-proxy/
├── src/
│   ├── index.ts          # Entry point, CLI arg parsing
│   ├── server.ts         # HTTP server
│   ├── claude.ts         # Claude CLI execution layer
│   ├── session.ts        # Session manager (rotation, lifecycle)
│   ├── format.ts         # Response formatting (Claude → OpenAI shape)
│   └── types.ts          # TypeScript types
├── test/
│   ├── server.test.ts    # HTTP endpoint tests
│   ├── session.test.ts   # Session rotation tests
│   ├── format.test.ts    # Response formatting tests
│   └── claude.test.ts    # CLI execution tests (mocked)
├── CLAUDE.md             # System prompt for the search Claude
├── README.md             # Public-facing docs
├── package.json
├── tsconfig.json
└── LICENSE
```

## MVP Scope (before first git push)

- [ ] HTTP server accepting POST /v1/chat/completions
- [ ] Also accept POST /chat/completions (without /v1 prefix)
- [ ] Extract query from OpenAI message format
- [ ] Execute `claude -p` with WebSearch tool
- [ ] Parse CLI output, extract citations
- [ ] Return OpenAI-compatible response
- [ ] Configurable port (default 3271)
- [ ] Configurable model (sonnet/haiku, default sonnet)
- [ ] Error handling (CLI failures, timeouts)
- [ ] Request queue (sequential to avoid rate limits)
- [ ] Tests passing
- [ ] README with quickstart
- [ ] npm package.json ready

## Port Choice

Default: **52480**. High enough to avoid conflicts, static so OpenClaw config stays stable.

## What This Is NOT

- Not a general Claude API proxy
- Not a replacement for Brave/Perplexity (it uses your Claude subscription)
- Not a hosted service — it's a local sidecar
- Not handling streaming (stateless request/response only)

## Open Questions (for implementation)

1. How does `claude -p --output-format json` structure WebSearch results? Need to test.
2. Does the `--system-prompt` flag work with `--allowedTools`? Need to verify.
3. Rate limiting behavior on Max plan with rapid sequential searches?
4. Should we support GET /health for monitoring?
