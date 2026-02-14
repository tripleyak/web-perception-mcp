#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base ?? `http://127.0.0.1:${args.port}`;
const configPath = args.config ?? path.join(process.cwd(), 'scripts', 'benchmark.config.json');
const reportPath = args.report ?? path.join(process.cwd(), 'scripts', 'benchmark.report.json');
const enforceThresholds = args.strict ?? true;
const useExistingConfig = args.useExistingConfig ?? false;
const startupTimeoutMs = args.startupTimeoutMs ?? 60_000;

const defaultBenchmarkConfig = {
  suites: [
    {
      name: 'baseline_dom',
      url: 'https://example.com',
      capture_profile: 'adaptive',
      steps: [
        {
          action: 'wait_for',
          wait_for: 'networkidle',
          timeout_ms: 12000,
          capture: { include_frame: true, include_dom: true, include_ax: true, include_network: true, max_frames: 4 },
        },
        {
          action: 'scroll',
          delta_y: 280,
          capture: { include_frame: false, include_network: true, include_dom: true },
        },
      ],
    },
    {
      name: 'modal_dialog',
      url: 'https://www.w3schools.com/howto/howto_css_modals.asp',
      capture_profile: 'frames_only',
      steps: [
        { action: 'wait', timeout_ms: 1200 },
        { action: 'scroll', delta_y: 220 },
      ],
    },
    {
      name: 'video_control',
      url: 'https://www.w3.org/2010/05/video/mediaevents.html',
      capture_profile: 'adaptive',
      steps: [
        { action: 'wait_for', wait_for: 'networkidle', timeout_ms: 12000 },
        { action: 'click', x: 120, y: 120, capture: { include_frame: true, max_frames: 6 } },
      ],
    },
  ],
  acceptance: {
    p50LatencyMs: 900,
    p95LatencyMs: 1800,
    minActionSuccessRateTyped: 0.95,
    minActionSuccessRateMixed: 0.85,
  },
};

let serverProcess;

async function ensureConfig() {
  if (useExistingConfig) {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw);
  }

  try {
    const existing = await fs.readFile(configPath, 'utf8');
    if (existing.trim().length > 0) {
      return JSON.parse(existing);
    }
  } catch {
    // no-op
  }

  await fs.writeFile(configPath, `${JSON.stringify(defaultBenchmarkConfig, null, 2)}\n`);
  return defaultBenchmarkConfig;
}

async function requestTool(base, tool, payload, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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

function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[idx] ?? 0;
}

function buildCaptureDefaults(step) {
  return {
    include_dom: true,
    include_ax: false,
    include_frame: true,
    include_network: true,
    max_frames: step?.capture?.max_frames ?? 4,
    ...(step.capture || {}),
  };
}

function buildStepPayload(sessionId, stepInput) {
  const { fallbacks, ignore_failures, ...safeStep } = stepInput;
  return {
    session_id: sessionId,
    ...safeStep,
    capture: buildCaptureDefaults(safeStep),
  };
}

function buildFallbackPayload(sessionId, baseStep, fallbackStep) {
  return buildStepPayload(sessionId, {
    ...baseStep,
    ...fallbackStep,
    capture: {
      ...buildCaptureDefaults(baseStep),
      ...(fallbackStep.capture || {}),
    },
  });
}

async function runSuite(base, suite) {
  const started = Date.now();
  const sessionCreate = await requestTool(base, 'web_agent_session_create', {
    target_url: suite.url,
    capture_profile: suite.capture_profile || 'adaptive',
    max_steps: 200,
  });
  const sessionId = sessionCreate.session_id;
  const stepLatencies = [];
  let actionSuccess = 0;
  let actionCount = 0;
  let attemptedActionCount = 0;
  const stepEvents = [];

  try {
    for (const step of suite.steps || []) {
      const isOptional = step.ignore_failures === true;
      const attempts = [buildStepPayload(sessionId, step)];
      if (Array.isArray(step.fallbacks)) {
        for (const fallback of step.fallbacks) {
          attempts.push(buildFallbackPayload(sessionId, step, fallback));
        }
      }

      const stepStart = Date.now();
      let result;
      let usedFallback = false;

      for (const [index, payload] of attempts.entries()) {
        try {
          usedFallback ||= index > 0;
          result = await requestTool(base, 'web_agent_step', payload);
          if (result?.action_result?.success) {
            break;
          }
          if (index === attempts.length - 1) {
            break;
          }
        } catch (error) {
          if (index === attempts.length - 1) {
            result = {
              action_result: {
                success: false,
                status: 'step_failed',
                detail: error instanceof Error ? error.message : 'step request failed',
              },
              latency_ms: Date.now() - stepStart,
              queue_health: { frame_queue_depth: 0, frame_queue_max: 0, dropped_frames: 0, pending_frames: 0 },
              error_codes: ['REQUEST_FAILED'],
              state: { network_events: [], queue_health: { frame_queue_depth: 0, frame_queue_max: 0, dropped_frames: 0, pending_frames: 0 }, frame_refs: [] },
              frame_refs: [],
            };
          }
        }
      }

      attemptedActionCount += 1;
      if (!isOptional) {
        actionCount += 1;
      }

      const latency = Date.now() - stepStart;
      if (!isOptional || result?.action_result?.success) {
        stepLatencies.push(result.latency_ms ?? latency);
      }
      stepEvents.push({
        action: step.action,
        success: result.action_result?.success ?? false,
        latency_ms: result.latency_ms ?? latency,
        queue_depth: result.queue_health?.frame_queue_depth,
        error_codes: result.error_codes ?? [],
        fallback_used: usedFallback,
      });
      if (!isOptional && result.action_result?.success) {
        actionSuccess += 1;
      }
    }
  } finally {
    await requestTool(base, 'web_agent_session_stop', {
      session_id: sessionId,
      preserve_artifacts: false,
    }).catch(() => undefined);
  }

  const duration = Date.now() - started;
  const successRate = actionCount === 0 ? 1 : actionSuccess / actionCount;

  return {
    name: suite.name,
    url: suite.url,
    action_count: actionCount,
    attempted_action_count: attemptedActionCount,
    action_success_rate: successRate,
    duration_ms: duration,
    p50_latency_ms: percentile(stepLatencies, 50),
    p95_latency_ms: percentile(stepLatencies, 95),
    step_events: stepEvents,
  };
};

function parseArgs(argv) {
  const out = {
    base: null,
    config: null,
    report: null,
    port: 3401,
    strict: true,
    useExistingConfig: false,
    startupTimeoutMs: 60_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === '--base' && value !== undefined) {
      out.base = value;
      i += 1;
      continue;
    }

    if (key === '--config' && value !== undefined) {
      out.config = value;
      i += 1;
      continue;
    }

    if (key === '--report' && value !== undefined) {
      out.report = value;
      i += 1;
      continue;
    }

    if (key === '--port' && value !== undefined) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        out.port = parsed;
      }
      i += 1;
      continue;
    }

    if (key === '--startup-timeout' && value !== undefined) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        out.startupTimeoutMs = parsed;
      }
      i += 1;
      continue;
    }

    if (key === '--no-strict') {
      out.strict = false;
      continue;
    }

    if (key === '--use-existing-config') {
      out.useExistingConfig = true;
      continue;
    }
  }

  return out;
}

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await delay(500);
  }
  return false;
}

async function startServerIfNeeded(base) {
  if (args.base) {
    return false;
  }

  serverProcess = spawn('node', ['dist/index.js'], {
    env: {
      ...process.env,
      MCP_TRANSPORT: 'rest',
      WEB_AGENT_REST_HOST: new URL(base).hostname,
      WEB_AGENT_REST_PORT: String(new URL(base).port),
    },
    stdio: 'inherit',
  });

  const healthy = await waitForHealth(`${base}/health`, startupTimeoutMs);
  if (!healthy) {
    throw new Error(`Benchmark server did not become healthy at ${base}`);
  }
  return true;
}

async function stopServerIfNeeded() {
  if (!serverProcess) {
    return;
  }
  serverProcess.kill('SIGTERM');
  await new Promise((resolve) => {
    serverProcess.once('exit', () => resolve());
  });
  serverProcess = undefined;
}

async function evaluateThresholds(config, results) {
  const allLatencies = [];
  const allActions = [];
  for (const result of results) {
    allLatencies.push(result.p50_latency_ms, result.p95_latency_ms);
    allActions.push(result.action_success_rate);
  }

  const overallP50 = percentile(allLatencies, 50);
  const overallP95 = percentile(allLatencies, 95);
  const pass = {
    p50_ok: overallP50 <= (config.acceptance?.p50LatencyMs ?? 900),
    p95_ok: overallP95 <= (config.acceptance?.p95LatencyMs ?? 1800),
  };

  const worstSuccess = allActions.length > 0 ? Math.min(...allActions) : 1;
  pass.success_ok = worstSuccess >= (config.acceptance?.minActionSuccessRateMixed ?? 0.85);
  pass.thresholds = {
    observed_p50_latency_ms: overallP50,
    observed_p95_latency_ms: overallP95,
    observed_min_success_rate: worstSuccess,
    target: {
      p50_latency_ms: config.acceptance?.p50LatencyMs ?? 900,
      p95_latency_ms: config.acceptance?.p95LatencyMs ?? 1800,
      min_success_rate: config.acceptance?.minActionSuccessRateMixed ?? 0.85,
    },
  };
  pass.all = pass.p50_ok && pass.p95_ok && pass.success_ok;
  return pass;
}

(async () => {
  const config = await ensureConfig();
  await startServerIfNeeded(baseUrl);

  try {
    const results = [];
    for (const suite of config.suites || []) {
      results.push(await runSuite(baseUrl, suite));
    }

    const thresholds = await evaluateThresholds(config, results);
    const report = {
      generated_at: new Date().toISOString(),
      base_url: baseUrl,
      suites: results,
      thresholds,
    };

    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[benchmark] report written: ${reportPath}`);
    console.log(`[benchmark] suites: ${results.length}`);
    console.log(`[benchmark] p50=${thresholds.thresholds.observed_p50_latency_ms} p95=${thresholds.thresholds.observed_p95_latency_ms}`);
    console.log(`[benchmark] success=${thresholds.thresholds.observed_min_success_rate}`);

    if (enforceThresholds && !thresholds.all) {
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  } catch (error) {
    console.error(`[benchmark] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  } finally {
    await stopServerIfNeeded();
  }
})().catch((error) => {
  console.error(`[benchmark] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
