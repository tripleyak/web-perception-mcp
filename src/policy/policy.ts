import { StatePacket, ActionInput, PolicyMode } from '../types.js';

export interface ActionDecision {
  allowed: boolean;
  reason?: string;
}

export interface PolicyAdapter {
  readonly mode: PolicyMode;
  shouldAllowAction(state: StatePacket | null, input: ActionInput): Promise<ActionDecision>;
}

export class PassthroughPolicy implements PolicyAdapter {
  readonly mode: PolicyMode = 'model_owns_action';

  async shouldAllowAction(_state: StatePacket | null, _input: ActionInput): Promise<ActionDecision> {
    return { allowed: true };
  }
}

export class DeterministicPolicy implements PolicyAdapter {
  readonly mode: PolicyMode = 'deterministic';

  async shouldAllowAction(_state: StatePacket | null, input: ActionInput): Promise<ActionDecision> {
    if (input.action === 'navigate' && input.url && /(^javascript:|^data:|^file:|^about:|^chrome:)/i.test(input.url)) {
      return { allowed: false, reason: 'navigate to unsafe scheme blocked' };
    }

    return { allowed: true };
  }
}

export function createPolicyAdapter(mode: PolicyMode): PolicyAdapter {
  return mode === 'deterministic' ? new DeterministicPolicy() : new PassthroughPolicy();
}
