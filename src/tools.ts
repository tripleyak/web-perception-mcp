import { z } from 'zod';
import {
  ActionInput,
  CaptureProfile,
  CreateResult,
  MCP_TOOL_NAMES,
  ReplayInput,
  ReplayManifest,
  SessionCreateInput,
  SessionStopResult,
  SnapshotInput,
  StepResult,
  StopInput,
  StatePacket,
} from './types.js';
import { validateAction, validateSessionCreate } from './security/validator.js';
import { SessionManager } from './session/session-manager.js';
import { ReplayStore } from './replay/replay.js';

const createSchema = z.object({
  target_url: z.string().url(),
  viewport: z
    .object({
      width: z.number().int().min(320).max(7680),
      height: z.number().int().min(200).max(4320),
    })
    .optional(),
  headless: z.boolean().optional(),
  storage_state: z.string().optional(),
  capture_profile: z.enum(['adaptive', 'dom_only', 'frames_only']).optional(),
  policy: z.enum(['model_owns_action', 'deterministic']).optional(),
  max_steps: z.number().int().positive().max(10000).optional(),
  max_duration_ms: z.number().int().positive().max(72_000_000).optional(),
});

const stepSchema = z.object({
  session_id: z.string().min(1),
  action: z.enum(['click', 'type', 'press', 'scroll', 'hover', 'drag', 'navigate', 'wait', 'wait_for']),
  selector: z.string().max(3000).optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  url: z.string().url().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  delta_x: z.number().optional(),
  delta_y: z.number().optional(),
  timeout_ms: z.number().int().min(50).max(120000).optional(),
  capture: z
    .object({
      include_frame: z.boolean().optional(),
      include_dom: z.boolean().optional(),
      include_ax: z.boolean().optional(),
      include_network: z.boolean().optional(),
      max_frames: z.number().int().min(1).max(64).optional(),
    })
    .optional(),
  confidence_gate: z
    .object({
      min_score: z.number().min(0).max(1).optional(),
    })
    .optional(),
  max_frame_budget_ms: z.number().int().positive().max(60_000).optional(),
  max_actions_per_step: z.number().int().min(1).max(20).optional(),
  wait_for: z.string().optional(),
});

const snapshotSchema = z.object({
  session_id: z.string().min(1),
  include_frame: z.boolean().optional(),
  include_dom: z.boolean().optional(),
  include_ax: z.boolean().optional(),
  include_network: z.boolean().optional(),
});

const stopSchema = z.object({
  session_id: z.string().min(1),
  preserve_artifacts: z.boolean().optional(),
});

const replaySchema = z.object({
  trace_id: z.string().min(1),
  step_range: z
    .object({
      start: z.number().int().min(1).optional(),
      end: z.number().int().min(1).optional(),
    })
    .optional(),
});

export class ToolHandler {
  constructor(
    private readonly sessionManager: SessionManager,
  ) {}

  listTools() {
    return [
      {
        name: MCP_TOOL_NAMES.create,
        description: 'Create a browser session with CDP-first DOM + frame capture',
        inputSchema: {
          type: 'object',
          properties: {
            target_url: { type: 'string', format: 'uri' },
            viewport: {
              type: 'object',
              properties: {
                width: { type: 'number', minimum: 320, maximum: 7680 },
                height: { type: 'number', minimum: 200, maximum: 4320 },
              },
              required: ['width', 'height'],
            },
            headless: { type: 'boolean' },
            storage_state: { type: 'string' },
            capture_profile: { type: 'string', enum: ['adaptive', 'dom_only', 'frames_only'] },
            policy: { type: 'string', enum: ['model_owns_action', 'deterministic'] },
            max_steps: { type: 'number', minimum: 1, maximum: 10000 },
            max_duration_ms: { type: 'number', minimum: 1000, maximum: 72000000 },
          },
          required: ['target_url'],
          additionalProperties: false,
        },
      },
      {
        name: MCP_TOOL_NAMES.step,
        description: 'Execute one action and return merged DOM, AX, network and frame state',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', minLength: 1 },
            action: { type: 'string', enum: ['click', 'type', 'press', 'scroll', 'hover', 'drag', 'navigate', 'wait', 'wait_for'] },
            selector: { type: 'string', maxLength: 3000 },
            text: { type: 'string' },
            key: { type: 'string' },
            url: { type: 'string', format: 'uri' },
            x: { type: 'number' },
            y: { type: 'number' },
            delta_x: { type: 'number' },
            delta_y: { type: 'number' },
            timeout_ms: { type: 'number', minimum: 50, maximum: 120000 },
            capture: {
              type: 'object',
              properties: {
                include_frame: { type: 'boolean' },
                include_dom: { type: 'boolean' },
                include_ax: { type: 'boolean' },
                include_network: { type: 'boolean' },
                max_frames: { type: 'number', minimum: 1, maximum: 64 },
              },
              additionalProperties: false,
            },
            confidence_gate: {
              type: 'object',
              properties: {
                min_score: { type: 'number', minimum: 0, maximum: 1 },
              },
              additionalProperties: false,
            },
            max_frame_budget_ms: { type: 'number', minimum: 1, maximum: 60000 },
            max_actions_per_step: { type: 'number', minimum: 1, maximum: 20 },
            wait_for: { type: 'string' },
          },
          required: ['session_id', 'action'],
          additionalProperties: false,
        },
      },
      {
        name: MCP_TOOL_NAMES.snapshot,
        description: 'Capture current merged state without taking action',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', minLength: 1 },
            include_frame: { type: 'boolean' },
            include_dom: { type: 'boolean' },
            include_ax: { type: 'boolean' },
            include_network: { type: 'boolean' },
          },
          required: ['session_id'],
          additionalProperties: false,
        },
      },
      {
        name: MCP_TOOL_NAMES.stop,
        description: 'Stop a browser session, cleanup resources, and return trace path',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', minLength: 1 },
            preserve_artifacts: { type: 'boolean' },
          },
          required: ['session_id'],
          additionalProperties: false,
        },
      },
      {
        name: MCP_TOOL_NAMES.replay,
        description: 'Read deterministic replay manifest for a finished session',
        inputSchema: {
          type: 'object',
          properties: {
            trace_id: { type: 'string', minLength: 1 },
            step_range: {
              type: 'object',
              properties: {
                start: { type: 'number' },
                end: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
          required: ['trace_id'],
          additionalProperties: false,
        },
      },
    ];
  }

  async create(raw: unknown): Promise<CreateResult> {
    const input = parse(createSchema, raw) as SessionCreateInput;
    const validation = validateSessionCreate(input);
    if (!validation.ok) {
      throw new Error(validation.errors.map((error) => `${error.code}: ${error.message}`).join('; '));
    }

    const captureProfile: CaptureProfile = input.capture_profile || 'adaptive';
    input.capture_profile = captureProfile;

    return this.sessionManager.create(input);
  }

  async step(raw: unknown): Promise<StepResult> {
    const input = parse(stepSchema, raw) as ActionInput;
    const validation = validateAction(input);
    if (!validation.ok) {
      throw new Error(validation.errors.map((error) => `${error.code}: ${error.message}`).join('; '));
    }

    const session = this.sessionManager.get(input.session_id);
    if (!session) {
      throw new Error(`Unknown session_id: ${input.session_id}`);
    }

    this.sessionManager.touch(input.session_id);
    return session.step(input);
  }

  async snapshot(raw: unknown): Promise<StatePacket> {
    const input = parse(snapshotSchema, raw) as SnapshotInput;
    const session = this.sessionManager.get(input.session_id);
    if (!session) {
      throw new Error(`Unknown session_id: ${input.session_id}`);
    }

    this.sessionManager.touch(input.session_id);
    return session.snapshot(input);
  }

  async stop(raw: unknown): Promise<SessionStopResult> {
    const input = parse(stopSchema, raw) as StopInput;
    const session = this.sessionManager.get(input.session_id);
    if (!session) {
      throw new Error(`Unknown session_id: ${input.session_id}`);
    }

    const stop = await session.stop(!!input.preserve_artifacts);
    await this.sessionManager.stop(input.session_id, !!input.preserve_artifacts);
    return {
      session_id: input.session_id,
      final_status: stop.status,
      cleanup_status: stop.cleanup,
      trace_path: stop.tracePath,
      retained_logs: stop.cleanup === 'retained',
    };
  }

  async replay(raw: unknown): Promise<ReplayManifest> {
    const input = parse(replaySchema, raw) as ReplayInput;
    if (input.step_range?.start !== undefined && input.step_range.end !== undefined && input.step_range.start > input.step_range.end) {
      throw new Error('step_range.start must be <= step_range.end');
    }

    const [events, manifest] = await Promise.all([
      ReplayStore.filter(input.trace_id, input.step_range?.start, input.step_range?.end),
      ReplayStore.load(input.trace_id),
    ]);
    return {
      ...manifest,
      events: events.sort((a, b) => a.index - b.index),
    };
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid tool arguments: ${message}`);
  }
  return result.data;
}
