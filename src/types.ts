export type CaptureProfile = 'adaptive' | 'dom_only' | 'frames_only';
export type PolicyMode = 'model_owns_action' | 'deterministic';

export type AgentAction =
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'hover'
  | 'drag'
  | 'navigate'
  | 'wait'
  | 'wait_for';

export interface ViewportInput {
  width: number;
  height: number;
}

export interface CaptureSettingsInput {
  include_frame?: boolean;
  include_dom?: boolean;
  include_ax?: boolean;
  include_network?: boolean;
  max_frames?: number;
}

export interface SessionCreateInput {
  target_url: string;
  viewport?: ViewportInput;
  headless?: boolean;
  storage_state?: string;
  capture_profile?: CaptureProfile;
  policy?: PolicyMode;
  max_steps?: number;
  max_duration_ms?: number;
}

export interface ActionInput {
  session_id: string;
  action: AgentAction;
  selector?: string;
  text?: string;
  key?: string;
  url?: string;
  x?: number;
  y?: number;
  delta_x?: number;
  delta_y?: number;
  timeout_ms?: number;
  capture?: CaptureSettingsInput;
  confidence_gate?: {
    min_score?: number;
  };
  max_frame_budget_ms?: number;
  max_actions_per_step?: number;
  wait_for?: string;
}

export interface SnapshotInput {
  session_id: string;
  include_frame?: boolean;
  include_dom?: boolean;
  include_ax?: boolean;
  include_network?: boolean;
}

export interface StopInput {
  session_id: string;
  preserve_artifacts?: boolean;
}

export interface ReplayInput {
  trace_id: string;
  step_range?: {
    start?: number;
    end?: number;
  };
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameRef {
  id: string;
  timestamp: number;
  width: number;
  height: number;
  mime: 'image/jpeg' | 'image/png' | string;
  checksum?: string;
  storage_path?: string;
  metadata?: Record<string, unknown>;
}

export interface RegionDetection {
  label: string;
  confidence: number;
  bounds: Bounds;
}

export interface DomElementSummary {
  tag: string;
  id?: string;
  name?: string;
  role?: string;
  text?: string;
  bounds?: Bounds;
  value?: string;
}

export interface DomSummary {
  interactive_count: number;
  text_inputs: number;
  buttons: number;
  links: number;
  iframes: number;
  canvas_nodes: number;
  top_elements: DomElementSummary[];
}

export interface NetworkEvent {
  id: string;
  url: string;
  method: string;
  status?: number;
  type?: string;
  time: number;
  failureText?: string;
}

export interface QueueHealth {
  frame_queue_depth: number;
  frame_queue_max: number;
  dropped_frames: number;
  pending_frames: number;
}

export interface StatePacket {
  state_token: string;
  timestamp: number;
  session_id: string;
  url: string;
  title: string;
  dom?: DomSummary;
  accessibility?: unknown;
  network_events: NetworkEvent[];
  frame_refs: FrameRef[];
  region_detections?: RegionDetection[];
  change_tokens: string[];
  queue_health: QueueHealth;
}

export interface ActionResult {
  action: AgentAction;
  success: boolean;
  status: string;
  target?: string;
  selector?: string;
  coordinates?: {
    x: number;
    y: number;
  };
  detail?: string;
  elapsed_ms?: number;
}

export interface StepResult {
  state: StatePacket;
  frame_refs: FrameRef[];
  action_result: ActionResult;
  error_codes: string[];
  next_recommendation: string;
  latency_ms: number;
  queue_health: QueueHealth;
}

export interface CreateResult {
  session_id: string;
  trace_id: string;
  session_capabilities: SessionCapabilities;
  initial_state_snapshot: StatePacket;
  frame_ref?: FrameRef;
}

export interface SessionStopResult {
  session_id: string;
  final_status: string;
  cleanup_status: string;
  trace_path?: string;
  retained_logs: boolean;
}

export interface ReplayEvent {
  type: 'create' | 'step' | 'snapshot' | 'stop';
  index: number;
  at: number;
  payload: unknown;
}

export interface ReplayManifest {
  trace_id: string;
  session_id?: string;
  created_at: number;
  events: ReplayEvent[];
}

export interface SessionCapabilities {
  capture_profile: CaptureProfile;
  max_steps: number;
  max_duration_ms?: number;
  dom_first: boolean;
  frame_capture: boolean;
  policy: PolicyMode;
}

export interface ToolError {
  code: string;
  message: string;
}

export const MCP_TOOL_NAMES = {
  create: 'web_agent_session_create',
  step: 'web_agent_step',
  snapshot: 'web_agent_snapshot',
  stop: 'web_agent_session_stop',
  replay: 'web_agent_replay',
} as const;
