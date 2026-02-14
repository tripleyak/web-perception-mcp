#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const base = args.base;
const targetUrl = args.target;

if (!base) {
  throw new Error('Missing --base argument');
}
if (!targetUrl) {
  throw new Error('Missing --target argument');
}

async function requestTool(tool, argumentsPayload, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(argumentsPayload),
      signal: controller.signal,
    });
    const body = await response.json();
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `Request failed (${response.status})`);
    }
    return body.result ?? body;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const create = await requestTool('web_agent_session_create', {
    target_url: targetUrl,
    capture_profile: 'adaptive',
    max_steps: 20,
  });

  if (!create?.session_id) {
    throw new Error('Session create did not return session_id');
  }

  let stopped = false;
  try {
    const step = await requestTool('web_agent_step', {
      session_id: create.session_id,
      action: 'wait_for',
      wait_for: 'networkidle',
      timeout_ms: 10000,
      capture: {
        include_dom: true,
        include_ax: true,
        include_network: true,
        include_frame: true,
        max_frames: 4,
      },
    });

    const snapshot = await requestTool('web_agent_snapshot', {
      session_id: create.session_id,
      include_dom: true,
      include_ax: true,
      include_network: true,
      include_frame: true,
    });

    const stop = await requestTool('web_agent_session_stop', {
      session_id: create.session_id,
      preserve_artifacts: false,
    });
    stopped = true;

    const result = {
      ok: true,
      session_id: create.session_id,
      trace_id: create.trace_id,
      step_action: step.action_result?.success,
      step_latency_ms: step.latency_ms,
      frame_refs: step.frame_refs?.length ?? 0,
      final_status: stop.final_status,
      queue_health: step.queue_health,
      snapshot_queue_depth: snapshot.queue_health?.frame_queue_depth,
    };

    console.log(JSON.stringify(result, null, 2));
    return 0;
  } finally {
    if (create?.session_id) {
      if (!stopped) {
        await requestTool('web_agent_session_stop', { session_id: create.session_id, preserve_artifacts: true }).catch(() => undefined);
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

function parseArgs(argv) {
  const out = { base: '', target: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--base' && value !== undefined) {
      out.base = value;
      i += 1;
      continue;
    }
    if (key === '--target' && value !== undefined) {
      out.target = value;
      i += 1;
      continue;
    }
  }
  return out;
}
