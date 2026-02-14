# Codex integration

Use MCP stdio and keep the action payload deterministic.

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

```json
{
  "tool": "web_agent_step",
  "arguments": {
    "session_id": "<session_id>",
    "action": "type",
    "selector": "input[name=q]",
    "text": "playwright automation" ,
    "capture": { "include_dom": true, "include_frame": true },
    "max_actions_per_step": 1
  }
}
```
