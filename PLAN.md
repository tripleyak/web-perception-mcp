# Plan: Open-Source, Model-Agnostic, MCP-based Real-Time Web-Perception + Action Tool for Coding Agents

## Summary
Ship a standalone MCP server that gives AI agents a deterministic `create_session -> step -> snapshot -> stop` control loop, using a CDP-first hybrid perception stack (DOM/AX + adaptive visual frames). Default behavior is no-human-in-the-loop: model calls only, receives structured state, performs actions, and loops until goal completion.

## Scope and success criteria
1. Implement a production-grade MCP toolchain that works for public web pages and works across different AI clients.
2. Prioritize deterministic action reliability (DOM-first) and enable vision when DOM is insufficient (canvas/video/overlay).
3. Add adaptive frame throttling, mandatory backpressure, bounded queues, and replay-safe logs.
4. Make the repo open-source and immediately usable as a plugin/MCP integration for Codex, Claude, and other agents.
5. Deliver automated test coverage and benchmark gates before release.

Target outcomes:
- Median step latency: <=900ms for DOM-first tasks.
- p95 step latency: <=1800ms for baseline sites at 720p with 1-3 FPS visual sampling.
- Backpressure drops/stalls: zero uncontrolled queue growth under 4x burst load.
- Action success on benchmark set: >=95% for typed DOM workflows, >=85% for mixed DOM+canvas scenarios.

## Assumptions and explicit defaults
- Runtime target: Linux/macOS/Windows containerized where Chrome can run headless.
- Primary capture stack: Playwright + Chromium CDP (`Page.startScreencast` + `Page.screencastFrameAck`) with DOM/AX snapshots as first-class state.
- Default transport: MCP stdio server.
- Transport compatibility layer: optional HTTP wrapper is deferred to phase 2.
- Public web pages only (no internal VPN assumptions in phase 1).
- Vision model is optional in the loop; tool returns frames and metadata, and caller decides when to spend vision tokens.

## Public APIs / interfaces to add
### MCP tools (initial release)
1. `web_agent_session_create`
- Input: `target_url`, optional `viewport`, `headless`, `storage_state` (optional path/label), `capture_profile` (`adaptive|dom_only|frames_only`), `policy` (`model_owns_action|deterministic`), `max_steps`.
- Output: `session_id`, `session_capabilities`, `initial_state_snapshot`, `frame_ref` (if enabled), `trace_id`.

2. `web_agent_step`
- Input: `session_id`, `action` (`click|type|press|scroll|hover|drag|navigate|wait|wait_for`), selector/coordinates fallback, `capture` settings, `confidence_gate` (`min_score`), `max_frame_budget_ms`, `max_actions_per_step`.
- Output: `state` (DOM summary, AX summary, url, network/events, screenshot/clip refs, change tokens), `frame_refs`, `action_result`, `error_codes`, `next_recommendation`, `latency_ms`, `queue_health`.

3. `web_agent_snapshot`
- Input: `session_id`, `include_frame`, `include_dom`, `include_ax`, `include_network`.
- Output: current merged state with optional `frame_ref` and `region_detections`.

4. `web_agent_session_stop`
- Input: `session_id`, `preserve_artifacts`.
- Output: final status, cleanup status, trace path, retained logs.

5. `web_agent_replay`
- Input: `trace_id`, optional `step_range`.
- Output: deterministic replay manifest for audit/debug.

### Internal interfaces
- `BrowserSessionManager` lifecycle, pool, cleanup.
- `CaptureCoordinator` with bounded frame ring buffer and CDP ack-driven throttle.
- `ObservationBuilder` to merge DOM, AX, and frame metadata into a normalized state packet.
- `ActionExecutor` with DOM-first strategy and coordinate fallback.
- `PolicyAdapter` interface (currently passthrough, future pluggable planners).

## Implementation plan
### Phase 0: Repository and packaging
1. Bootstrap TypeScript MCP server with strict config and workspace structure:
   - `src/index.ts`, `src/tools.ts`, `src/session/session-manager.ts`, `src/capture/cdp.ts`, `src/observe/state-builder.ts`, `src/actions/driver.ts`, `src/security/validator.ts`, `src/telemetry/metrics.ts`.
2. Add license, CONTRIBUTING, CODEOWNERS, `Dockerfile`, GitHub workflow.
3. Publish MCP manifest in `mcp-server` conventions.

### Phase 1: Hybrid perception core
1. Build Chromium session startup and attach CDP session.
2. Implement screencast with `Page.startScreencast` and frame ack.
3. Add ring buffers: frame ring (raw), embedding placeholder, event ring.
4. Add adaptive sampling defaults:
   - baseline 1-3 FPS,
   - burst to 6-10 FPS on DOM-unstable/visual drift cues.

### Phase 2: Action loop and safety
1. Implement action execution across:
   - DOM/ARIA targeting and fallback coordinate dispatch.
   - safe waits (`stable`, `visible`, `network idle`, timeout).
2. Add bounded retries, idempotent navigation handling, and deterministic action/result schema.
3. Add security guardrails:
   - domain allow/deny defaults,
   - max duration/steps,
   - sensitive token masking in logs,
   - explicit unsafe action refusal policy.

### Phase 3: AI-agnostic compatibility and tool ergonomics
1. Keep tool I/O schema provider-neutral and transport-agnostic.
2. Add thin adapters:
   - MCP stdio (default),
   - optional REST bridge wrapper in `src/adapters/rest.ts` for clients that prefer HTTP.
3. Add examples for Codex/Claude/other clients using identical JSON payloads.

### Phase 4: Reliability, replay, and operations
1. Implement trace logging + deterministic replay artifacts.
2. Add heartbeat and self-healing:
   - stale session GC,
   - browser crash auto-restart inside session.
3. Add rate limit + concurrency controls.
4. Add observability:
   - latency histograms, queue depth, frame drop count, action failure buckets.

### Phase 5: Release hardening
1. Build benchmark harness against test sites with:
   - forms, modal dialogs, dynamic DOM, canvas-only controls, video playback page.
2. Add Docker and one-command local smoke flow.
3. Publish docs for:
   - install/run,
   - security boundaries,
   - agent integration playbook.

## Testing plan and scenarios
| Category | Scenario | Acceptance |
|---|---|---|
| Unit | Frame queue and ack gating | No queue overrun; drop oldest when pressure; ack always sent |
| Unit | Action schema validation | Invalid action rejected before browser call |
| Integration | DOM form submit flow | >95% successful completion within 90s |
| Integration | Canvas fallback click via coordinates | >85% successful completion without DOM handles |
| Integration | Public video page with muted player + overlay | tool returns frame refs and consistent state while still allowing control |
| Endurance | 20 min burst loop with frame throttling | p95 latency stable, no unbounded memory growth |
| Security | Unauthorized action attempts | blocked with explicit error codes |

## Rollout and monitoring
1. Start with one controlled canary (single-agent use) for 1 week.
2. Track p50/p95 latency, failure rate, frame drop %, action rollback count.
3. Enable public repo release once stability threshold holds for 3 consecutive benchmark runs.
4. Provide migration notes: CDP-only mode in v1, optional WebRTC/getDisplayMedia in v2 for low-latency streaming.

## Assumption log (to remove ambiguity at implementation time)
- Incompatible browser media constraints (DRM/cross-origin restrictions) are treated as constrained domains, not hard errors; return explicit capability flags for fallback actions.
- Model-agnostic operation is maintained by not embedding model-specific prompt logic in tool code.
- This plan intentionally excludes direct human confirmation workflows in phase 1 to satisfy full autonomy.
