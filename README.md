# claude-proxy

Local observability proxy for Claude Code API traffic — inspect token usage, classify request types, and optionally route agent requests to OpenAI-compatible models.

---

## What it does

claude-proxy sits between Claude Code and the Anthropic API. It observes every request and response without modifying the body, logs structured metrics to JSONL, and (optionally) routes agent worker requests to an alternative model.

| Capability | Phase | Status |
|---|---|---|
| Pass-through proxy with per-turn metrics | 1 | Released |
| Request classification by type | 1 | Released |
| Shadow evaluation against OpenAI-compatible models | 1 | Released |
| Selective routing of agent requests | 2 | Released |
| 529 fallback to OpenAI-compatible models | 2 | Released |
| Terminal dashboard (TUI) | 2 | Released |
| Retry response caching | 3 | Released |
| Optimization recommendations (`advise`) | 3 | Released |

---

## Quick Start

**Requirements:** Node.js 18+, no additional runtime dependencies.

```bash
# Install globally
npm install -g claude-proxy

# Start the proxy
claude-proxy start

# In the same or another terminal, point Claude Code at the proxy
ANTHROPIC_BASE_URL=http://localhost:8080 claude

# After a session, view metrics
claude-proxy stats

# Open the live dashboard
claude-proxy dashboard
```

That's it. Claude Code operates normally. Metrics are written to `~/.claude-proxy/logs/metrics.jsonl`.

---

## Installation

**From npm:**

```bash
npm install -g claude-proxy
```

**From source:**

```bash
git clone https://github.com/whynowlab/claude-proxy
cd claude-proxy
npm link
```

**Prerequisites:**

- Node.js 18 or later
- `ANTHROPIC_API_KEY` set in your environment (Claude Code reads this; the proxy passes it through)
- `OPENAI_API_KEY` set if you want shadow evaluation or routing to an OpenAI-compatible model

---

## Usage

### Start the proxy

```bash
claude-proxy start [--port 8080] [--host 127.0.0.1] [--config .proxy.config.json]
```

Default port is `8080`, bound to `127.0.0.1` only. Point Claude Code at it:

```bash
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

For persistent use, add to your shell profile:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
```

To stop routing through the proxy, unset the variable:

```bash
unset ANTHROPIC_BASE_URL
```

### View metrics

```bash
# Aggregate stats across all sessions
claude-proxy stats

# Stats for a specific session
claude-proxy stats --session <session-id>

# Read from a non-default log file
claude-proxy stats --log /path/to/metrics.jsonl
```

Example output:

```
Session: sess_01xYZ
  Period:              2026-04-02T10:00:00Z → 2026-04-02T11:23:00Z
  Turns:               47
  Input tokens:        842,000
  Output tokens:       38,200
  Avg cache hit rate:  78.3%
  Agent request ratio: 43.2%
  Retries:             2
  Context growth/turn: 4,100 tokens
```

### Get optimization recommendations

```bash
claude-proxy advise [--log path]
```

Analyzes your metrics log and prints actionable recommendations — for example, if your cache hit rate is low, or if your agent request ratio is high enough to benefit from routing.

### Open the dashboard

```bash
claude-proxy dashboard [--session <id>] [--log path]
```

Terminal UI showing live request flow, token consumption, and per-session breakdowns. Refreshes as new metrics arrive.

### Stop the proxy

```bash
claude-proxy stop
```

---

## Features

### Request Classification

Every request is classified by its source type, extracted from the request metadata:

| Type | Description | Default routing |
|---|---|---|
| `repl_main_thread` | Your direct conversation turns | Anthropic |
| `agent:custom` | Custom subagent calls | Anthropic (Codex-routable in Phase 2) |
| `agent:default` | Built-in agent calls | Anthropic (Codex-routable in Phase 2) |
| `compact` | Background context compression | Anthropic |
| `verification_agent` | Verification passes | Anthropic |

Classification is observed from traffic — no code modification required.

### Shadow Evaluation

When shadow mode is enabled, agent requests are **also** sent to an OpenAI-compatible model in parallel. The proxy logs both responses for comparison. Your Claude Code session uses the Anthropic response; shadow results are metrics only.

This lets you evaluate model quality before enabling routing.

Configure in `.proxy.config.json`:

```json
"shadow": {
  "enabled": true,
  "target_query_sources": ["agent:custom", "agent:default"],
  "max_tool_count": 5
}
```

`max_tool_count` limits shadow evaluation to requests with 5 or fewer tools. Requests with large tool arrays are excluded from shadow to avoid excessive token spend on the OpenAI side.

### Routing (Phase 2)

Route agent requests to an OpenAI-compatible model instead of Anthropic. Only activates when `routing.enabled` is `true` and rules match. All other requests continue to Anthropic unchanged.

The proxy converts request and response formats transparently. Claude Code sees a normal Anthropic SSE stream regardless of which model handled the request.

Enable routing:

```json
"routing": {
  "enabled": true,
  "rules": [
    { "query_source": "agent:custom" },
    { "query_source": "agent:default" }
  ]
}
```

### 529 Fallback (Phase 2)

When Anthropic returns a 529 (overloaded), the proxy automatically retries the request against your OpenAI-compatible model. Fallback only fires before streaming starts — mid-stream responses are never switched.

```json
"fallback_529": {
  "enabled": true,
  "target_query_sources": ["agent:custom", "agent:default"]
}
```

### Retry Caching (Phase 3)

The proxy caches responses by `x-client-request-id`. If Claude Code retries an identical request (e.g., after a 529), the cached response is returned immediately without an additional API call. No extra token spend on retries.

---

## Configuration

Default config file: `.proxy.config.json` in the directory where you run `claude-proxy start`. Override with `--config path`.

```json
{
  "anthropic": {
    "base_url": "https://api.anthropic.com",
    "api_key_env": "ANTHROPIC_API_KEY"
  },
  "openai": {
    "base_url": "https://api.openai.com/v1",
    "api_key_env": "OPENAI_API_KEY",
    "default_model": "gpt-5.4"
  },
  "shadow": {
    "enabled": true,
    "target_query_sources": ["agent:custom", "agent:default"],
    "max_tool_count": 5,
    "thinking_enabled": false
  },
  "routing": {
    "enabled": false,
    "rules": []
  },
  "fallback_529": {
    "enabled": false,
    "target_query_sources": ["agent:custom", "agent:default"]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `anthropic.base_url` | string | Upstream Anthropic API endpoint |
| `anthropic.api_key_env` | string | Env var name for your Anthropic key |
| `openai.base_url` | string | OpenAI-compatible endpoint for shadow/routing/fallback |
| `openai.api_key_env` | string | Env var name for your OpenAI key |
| `openai.default_model` | string | Model to use for shadow/routing (e.g., `gpt-5.4`) |
| `shadow.enabled` | boolean | Enable parallel shadow evaluation |
| `shadow.target_query_sources` | string[] | Which request types to shadow |
| `shadow.max_tool_count` | number | Skip shadow if request has more tools than this |
| `routing.enabled` | boolean | Enable request routing to OpenAI-compatible model |
| `routing.rules` | object[] | Routing rules (match by `query_source`) |
| `fallback_529.enabled` | boolean | Enable automatic 529 fallback |
| `fallback_529.target_query_sources` | string[] | Which request types are eligible for fallback |

---

## How It Works

```
Claude Code  →  localhost:8080  ──→  Anthropic API
                    │
                    ├─ Logs per-turn metrics to JSONL
                    ├─ Classifies request type (query_source)
                    ├─ Shadow eval (parallel, results-only)
                    ├─ Routes agent requests (if routing.enabled)
                    └─ Fallback on 529 (if fallback_529.enabled)
```

The proxy is a transparent HTTP intermediary. It reads request and response bodies to extract metrics, but passes the request body to Anthropic unmodified. This preserves request integrity, including any embedded authentication material in the body.

Routing and fallback convert between Anthropic and OpenAI message formats on the fly, including SSE streaming. Claude Code always receives an Anthropic-format response.

All data stays local. The proxy binds to `127.0.0.1` only. API keys are masked in logs. Log files rotate automatically after 7 days.

---

## Metrics Log Format

One JSON line per request-response pair, written to `~/.claude-proxy/logs/metrics.jsonl`:

```json
{
  "ts": "2026-04-02T16:30:00Z",
  "session_id": "sess_01xYZ",
  "request_id": "req_abc123",
  "query_source": "agent:custom",
  "model": "claude-opus-4-6",
  "input_tokens": 18432,
  "output_tokens": 2100,
  "cache_read": 15000,
  "cache_write": 3000,
  "cache_hit_rate": 0.81,
  "ttfb_ms": 1200,
  "duration_ms": 3400,
  "tool_count": 23,
  "message_count": 12,
  "is_retry": false,
  "thinking": true,
  "routed_to": "anthropic",
  "status": 200
}
```

---

## Requirements

- Node.js 18 or later
- No production dependencies (uses Node.js built-in modules only)
- `ANTHROPIC_API_KEY` in environment
- `OPENAI_API_KEY` in environment (required for shadow, routing, or fallback features)

---

## Graceful Degradation

If the proxy stops or crashes, Claude Code continues to work normally. Remove or unset `ANTHROPIC_BASE_URL` to bypass the proxy entirely:

```bash
unset ANTHROPIC_BASE_URL
claude  # connects directly to Anthropic
```

---

## License

MIT
