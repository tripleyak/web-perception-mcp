import { Browser, BrowserContext, chromium, Page, Request, Route } from 'playwright';
import path from 'path';
import { CaptureCoordinator } from '../capture/cdp.js';
import { ReplayStore } from '../replay/replay.js';
import { ActionExecutor } from '../actions/driver.js';
import { StateBuilder } from '../observe/state-builder.js';
import { MetricsCollector } from '../telemetry/metrics.js';
import { ActionInput, ActionResult, CreateResult, FrameRef, NetworkEvent, ReplayManifest, SessionCreateInput, StatePacket, StepResult } from '../types.js';
import { CaptureProfile, CaptureSettingsInput, ReplayEvent, SnapshotInput } from '../types.js';
import { PolicyAdapter } from '../policy/policy.js';

const DEFAULT_CAPTURE_MAX_FRAMES = 8;
const DEFAULT_MAX_STEPS = 500;
const DEFAULT_MAX_DURATION_MS = 20 * 60 * 1000;

export interface BrowserSessionParams {
  input: SessionCreateInput;
  policy: PolicyAdapter;
  maxSteps: number;
  traceId: string;
  captureProfile: CaptureProfile;
  headless: boolean;
  viewport?: { width: number; height: number };
  storageState?: string;
  maxFrames: number;
  maxDurationMs?: number;
  metrics: MetricsCollector;
}

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private captureCoordinator?: CaptureCoordinator;
  private stateBuilder?: StateBuilder;
  private actionExecutor?: ActionExecutor;
  private networkEvents: NetworkEvent[] = [];
  private requestId = 0;
  private active = false;
  private stepIndex = 0;
  private createdAt = Date.now();
  private lastFrame?: FrameRef;

  constructor(
    public readonly id: string,
    private readonly params: BrowserSessionParams,
  ) {}

  async start(): Promise<CreateResult> {
    if (this.active) {
      throw new Error('session already started');
    }

    const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    this.browser = await chromium.launch({ headless: this.params.headless, args: browserArgs });

    this.context = await this.browser.newContext({
      viewport: this.params.viewport,
      ...(this.params.storageState ? { storageState: this.params.storageState } : {}),
    });

    this.page = await this.context.newPage();
    this.networkEvents = [];

    this.context.on('request', (request: Request) => {
      this.networkEvents.push({
        id: `r_${Date.now()}_${++this.requestId}`,
        url: request.url(),
        method: request.method(),
        type: request.resourceType(),
        time: Date.now(),
        status: undefined,
      });
      if (this.networkEvents.length > 500) {
        this.networkEvents.shift();
      }
    });

    this.context.on('response', (response) => {
      this.networkEvents.push({
        id: `p_${Date.now()}_${++this.requestId}`,
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        type: response.request().resourceType(),
        time: Date.now(),
      });
      if (this.networkEvents.length > 500) {
        this.networkEvents.shift();
      }
    });

    this.context.on('requestfailed', (request) => {
      this.networkEvents.push({
        id: `f_${Date.now()}_${++this.requestId}`,
        url: request.url(),
        method: request.method(),
        status: 0,
        type: request.resourceType(),
        time: Date.now(),
        failureText: request.failure()?.errorText,
      });
      if (this.networkEvents.length > 500) {
        this.networkEvents.shift();
      }
    });

    const traceDir = path.join('traces', this.params.traceId);
    const includeFrames = this.params.captureProfile !== 'dom_only';
    this.captureCoordinator = new CaptureCoordinator({
      page: this.page,
      context: this.context,
      options: {
        enabled: includeFrames,
        traceId: this.params.traceId,
        sessionId: this.id,
        frameQuality: 65,
        maxWidth: this.params.viewport?.width,
        maxHeight: this.params.viewport?.height,
        maxFrames: this.params.maxFrames,
        adaptive: this.params.captureProfile === 'adaptive',
        traceDir,
      },
      events: {
        onFrame: async (frame) => {
          this.lastFrame = frame;
        },
      },
    });

    await this.captureCoordinator.start();

    this.actionExecutor = new ActionExecutor(this.page);
    this.stateBuilder = new StateBuilder(this.page, this.captureCoordinator, this.networkEvents);

    await this.page.route('**', (route: Route) => route.continue());

    await this.page.goto(this.params.input.target_url, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });

    this.active = true;
    this.createdAt = Date.now();

    const initialState = await this.buildStateSnapshot({
      includeDom: this.params.captureProfile !== 'frames_only',
      includeAx: true,
      includeNetwork: true,
      includeFrame: includeFrames,
      maxFrames: this.params.maxFrames,
    });

    await this.recordReplayEvent('create', {
      session_id: this.id,
      initial_state_snapshot: initialState,
      capabilities: this.buildCapabilities(),
    });

    return {
      session_id: this.id,
      trace_id: this.params.traceId,
      session_capabilities: this.buildCapabilities(),
      initial_state_snapshot: initialState,
      frame_ref: this.lastFrame,
    };
  }

  async step(input: ActionInput): Promise<StepResult> {
    if (!this.active || !this.page || !this.actionExecutor || !this.stateBuilder) {
      throw new Error('session is not active');
    }

    if (this.stepIndex >= this.params.maxSteps) {
      throw new Error(`max_steps reached: ${this.params.maxSteps}`);
    }

    if (Date.now() - this.createdAt > (this.params.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)) {
      throw new Error('session exceeded max_duration_ms');
    }

    const stepStart = Date.now();
    const captureSettings = this.normalizeCaptureSettings(input.capture);

    const beforeState = await this.buildStateSnapshot(captureSettings);
    const preDecision = this.params.policy
      ? await this.params.policy.shouldAllowAction(beforeState, input)
      : { allowed: true };

    if (!preDecision.allowed) {
      return {
        state: beforeState,
        frame_refs: beforeState.frame_refs,
        action_result: {
          action: input.action,
          success: false,
          status: 'policy_denied',
          detail: preDecision.reason ?? 'action blocked by policy',
          elapsed_ms: Date.now() - stepStart,
        },
        error_codes: ['POLICY_DENIED'],
        next_recommendation: 'halt',
        latency_ms: Date.now() - stepStart,
        queue_health: beforeState.queue_health,
      };
    }

    const actionResult: ActionResult = await this.actionExecutor.execute(input, this.networkEvents);

    if (!actionResult.success) {
      this.params.metrics.recordActionFailure();
    }

    if (input.action === 'wait_for' || input.action === 'wait') {
      this.captureCoordinator?.signalVisualDrift();
    }

    const state = await this.buildStateSnapshot(captureSettings);
    const latency = Date.now() - stepStart;

    this.stepIndex += 1;
    this.createdAt = Date.now();
    this.params.metrics.recordStepLatency(latency);

    const stepResult: StepResult = {
      state,
      frame_refs: state.frame_refs,
      action_result: actionResult,
      error_codes: actionResult.success ? [] : ['ACTION_FAILED'],
      next_recommendation: actionResult.success ? 'continue' : this.shouldRetry(actionResult) ? 'retry' : 'fallback_or_abandon',
      latency_ms: latency,
      queue_health: state.queue_health,
    };

    if (stepResult.state.network_events.length === 0) {
      stepResult.error_codes.push('NO_NETWORK_EVENT');
    }

    await this.recordReplayEvent('step', stepResult);
    return stepResult;
  }

  async snapshot(input: SnapshotInput): Promise<StatePacket> {
    const state = await this.buildStateSnapshot({
      includeDom: !!input.include_dom,
      includeAx: !!input.include_ax,
      includeFrame: !!input.include_frame,
      includeNetwork: !!input.include_network,
      maxFrames: this.params.maxFrames,
    });
    await this.recordReplayEvent('snapshot', state);
    return state;
  }

  async stop(preserveArtifacts = false): Promise<{ status: string; cleanup: string; tracePath: string; sessionId: string }> {
    if (!this.active) {
      return {
        status: 'already_stopped',
        cleanup: 'noop',
        tracePath: ReplayStore.buildTracePath(this.params.traceId),
        sessionId: this.id,
      };
    }

    this.active = false;

    await this.captureCoordinator?.stop();

    if (this.page && !this.page.isClosed()) {
      await this.page.close({ runBeforeUnload: false }).catch(() => undefined);
    }

    if (this.context) {
      await this.context.close().catch(() => undefined);
    }

    if (this.browser) {
      await this.browser.close().catch(() => undefined);
    }

    await this.recordReplayEvent('stop', { session_id: this.id, preserveArtifacts }).catch(() => undefined);

    if (!preserveArtifacts) {
      await ReplayStore.cleanup(this.params.traceId).catch(() => undefined);
    }

    const tracePath = ReplayStore.buildTracePath(this.params.traceId);

    return {
      status: 'stopped',
      cleanup: preserveArtifacts ? 'retained' : 'cleaned',
      tracePath,
      sessionId: this.id,
    };
  }

  async getLastActivity(): Promise<number> {
    return this.createdAt;
  }

  async getTrace(): Promise<ReplayManifest> {
    return ReplayStore.load(this.params.traceId);
  }

  private async buildStateSnapshot(
    capture: {
      includeDom: boolean;
      includeAx: boolean;
      includeNetwork: boolean;
      includeFrame: boolean;
      maxFrames?: number;
    },
  ): Promise<StatePacket> {
    if (!this.stateBuilder) {
      throw new Error('state builder not initialized');
    }
    const state = await this.stateBuilder.buildStateSnapshot(capture);
    return this.stateBuilder.withSessionId(state, this.id);
  }

  private buildCapabilities() {
    const maxDuration = this.params.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    return {
      capture_profile: this.params.captureProfile,
      max_steps: this.params.maxSteps,
      max_duration_ms: maxDuration,
      policy: this.params.policy.mode,
      dom_first: true,
      frame_capture: this.params.captureProfile !== 'dom_only',
    };
  }

  private normalizeCaptureSettings(
    input?: CaptureSettingsInput,
  ): {
    includeDom: boolean;
    includeAx: boolean;
    includeFrame: boolean;
    includeNetwork: boolean;
    maxFrames?: number;
  } {
    const maxFrames = input?.max_frames;
    if (!input) {
      return {
        includeDom: this.params.captureProfile !== 'frames_only',
        includeAx: this.params.captureProfile !== 'frames_only',
        includeFrame: this.params.captureProfile !== 'dom_only',
        includeNetwork: true,
        maxFrames: this.params.maxFrames,
      };
    }

    const hasAny = input.include_dom || input.include_ax || input.include_frame || input.include_network;
    if (!hasAny) {
      return {
        includeDom: this.params.captureProfile !== 'frames_only',
        includeAx: this.params.captureProfile !== 'frames_only',
        includeFrame: this.params.captureProfile !== 'dom_only',
        includeNetwork: true,
        maxFrames,
      };
    }

    return {
      includeDom: !!input.include_dom,
      includeAx: !!input.include_ax,
      includeFrame: !!input.include_frame,
      includeNetwork: !!input.include_network,
      maxFrames,
    };
  }

  private async recordReplayEvent(type: 'create' | 'step' | 'snapshot' | 'stop', payload: unknown): Promise<void> {
    const existing = await ReplayStore.load(this.params.traceId).catch(async () => null);
    const nextIndex = existing ? existing.events.length : 0;

    const event: ReplayEvent = {
      type,
      index: nextIndex + 1,
      at: Date.now(),
      payload,
    };

    await ReplayStore.append(this.params.traceId, event);
    await ReplayStore.persistTraceIndex(this.params.traceId, [...(existing?.events ?? []), event]);
  }

  private shouldRetry(result: ActionResult): boolean {
    if (!result.success) {
      return !result.detail?.toLowerCase().includes('timeout');
    }
    return false;
  }
}

export async function createBrowserSession(
  id: string,
  input: SessionCreateInput,
  config: {
    policy: PolicyAdapter;
    captureProfile: CaptureProfile;
    maxSteps?: number;
    traceId: string;
    headless: boolean;
    viewport?: { width: number; height: number };
    storageState?: string;
    maxFrames: number;
    maxDurationMs?: number;
    metrics: MetricsCollector;
  },
): Promise<BrowserSession> {
  return new BrowserSession(id, {
    input,
    policy: config.policy,
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    traceId: config.traceId,
    captureProfile: config.captureProfile,
    headless: config.headless,
    viewport: config.viewport,
    storageState: config.storageState,
    maxFrames: config.maxFrames,
    maxDurationMs: config.maxDurationMs,
    metrics: config.metrics,
  });
}

export function getDefaultMaxFrames(captureProfile: CaptureProfile, requestMax?: number): number {
  const cap = requestMax ? Math.min(20, Math.max(2, requestMax)) : DEFAULT_CAPTURE_MAX_FRAMES;
  if (captureProfile === 'frames_only') {
    return cap;
  }
  return Math.min(12, Math.max(3, cap));
}
