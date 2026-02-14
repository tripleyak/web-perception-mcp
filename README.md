# Web Perception Agent MCP

Open-source MCP server that exposes a deterministic web control loop for coding agents: `create -> step -> snapshot -> stop` with hybrid DOM + frame perception.

## Capabilities

- CDP-first perception via `Page.startScreencast`
- DOM and accessibility summaries
- Frame metadata + optional frame files
- Bounded ring buffers and backpressure tracking
- Deterministic action execution with selector-first + coordinate fallback
- Replay manifest per session (`web_agent_replay`)
- stdio transport (default) + optional REST bridge

## Tool contract

- `web_agent_session_create`
- `web_agent_step`
- `web_agent_snapshot`
- `web_agent_session_stop`
- `web_agent_replay`

## Run

```bash
npm install
npx playwright install --with-deps chromium
npm run build
npm run start
```

## One-command checks

```bash
npm run smoke
npm run benchmark
```

Smoke and benchmark scripts use the REST transport on port 3400 by default and validate the create/step/snapshot/stop flow.

### Real-site video checks

```bash
npm run smoke:youtube
npm run benchmark:youtube
```

`smoke:youtube` runs the smoke flow against a real YouTube video URL.

`benchmark:youtube` runs YouTube plus W3 animation media suites with DOM + frame fallbacks.

## REST bridge

```bash
MCP_TRANSPORT=rest WEB_AGENT_REST_PORT=3400 node dist/index.js
```

Example:

```bash
curl -s http://localhost:3400/tools/web_agent_session_create \
  -H "Content-Type: application/json" \
  -d '{"target_url":"https://example.com"}'
```

## MCP stdio examples

```json
{
  "name": "web_agent_session_create",
  "arguments": {
    "target_url": "https://example.com",
    "capture_profile": "adaptive",
    "max_steps": 200
  }
}
```

```json
{
  "name": "web_agent_step",
  "arguments": {
    "session_id": "<session-id>",
    "action": "click",
    "selector": "button[type=submit]",
    "capture": {
      "include_dom": true,
      "include_frame": true
    }
  }
}
```

```json
{
  "name": "web_agent_snapshot",
  "arguments": {
    "session_id": "<session-id>",
    "include_dom": true,
    "include_network": true,
    "include_frame": true
  }
}
```

```json
{
  "name": "web_agent_session_stop",
  "arguments": {
    "session_id": "<session-id>",
    "preserve_artifacts": true
  }
}
```

```json
{
  "name": "web_agent_replay",
  "arguments": {
    "trace_id": "trace_1700000000000_...",
    "step_range": { "start": 1, "end": 20 }
  }
}
```

## Environment

- `MCP_TRANSPORT=stdio|rest`
- `MCP_MAX_SESSIONS`
- `MCP_HEADLESS`
- `WEB_AGENT_ALLOWLIST`
- `WEB_AGENT_DENYLIST`
- `WEB_AGENT_REST_PORT`
- `WEB_AGENT_REST_HOST`
- `WEB_AGENT_POLICY=model_owns_action|deterministic`

## Quality and release

Recommended checks:

- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run benchmark`
