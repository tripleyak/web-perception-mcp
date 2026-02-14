# Claude integration

# 1) Create session

```json
{
  "tool": "web_agent_session_create",
  "arguments": {
    "target_url": "https://duckduckgo.com",
    "capture_profile": "adaptive",
    "max_steps": 500
  }
}
```

# 2) Execute a typing action

```json
{
  "tool": "web_agent_step",
  "arguments": {
    "session_id": "<session-id>",
    "action": "type",
    "selector": "input[name=q]",
    "text": "playwright automation",
    "capture": {
      "include_dom": true,
      "include_frame": true
    },
    "max_actions_per_step": 1
  }
}
```

# 3) Snapshot current state

```json
{
  "tool": "web_agent_snapshot",
  "arguments": {
    "session_id": "<session-id>",
    "include_dom": true,
    "include_ax": true,
    "include_frame": true
  }
}
```

# 4) Stop session

```json
{
  "tool": "web_agent_session_stop",
  "arguments": {
    "session_id": "<session-id>",
    "preserve_artifacts": false
  }
}
```

# 5) Optional replay

```json
{
  "tool": "web_agent_replay",
  "arguments": {
    "trace_id": "<trace-id>",
    "step_range": {
      "start": 1,
      "end": 10
    }
  }
}
```
  
