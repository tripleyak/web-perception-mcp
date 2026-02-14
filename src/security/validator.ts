import { AgentAction, SessionCreateInput, ActionInput } from '../types.js';

export interface ValidationError {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const DISALLOWED_SCHEMES = new Set(['chrome://', 'file://', 'about:']);

export function validateUrl(targetUrl: string, explicitAllowlist?: string[], explicitDenylist?: string[]): ValidationResult {
  const errors: ValidationError[] = [];

  try {
    const parsed = new URL(targetUrl);
    const scheme = parsed.protocol;

    if (!ALLOWED_SCHEMES.has(scheme)) {
      errors.push({ code: 'INVALID_SCHEME', message: `Unsupported scheme: ${scheme}` });
    }

    const origin = `${scheme}//`;
    if (DISALLOWED_SCHEMES.has(origin)) {
      errors.push({ code: 'DISALLOWED_SCHEME', message: `Blocked scheme: ${scheme}` });
    }

    const host = parsed.hostname.toLowerCase();

    if (explicitAllowlist && explicitAllowlist.length > 0) {
      const allowed = explicitAllowlist
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const match = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
      if (!match) {
        errors.push({ code: 'DOMAIN_NOT_ALLOWED', message: `Host ${host} not in allowlist` });
      }
    }

    if (explicitDenylist && explicitDenylist.length > 0) {
      const denied = explicitDenylist
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const blocked = denied.some((entry) => host === entry || host.endsWith(`.${entry}`));
      if (blocked) {
        errors.push({ code: 'DOMAIN_DENIED', message: `Host ${host} is denied` });
      }
    }
  } catch {
    errors.push({ code: 'INVALID_URL', message: 'Unable to parse URL' });
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateSessionCreate(input: SessionCreateInput): ValidationResult {
  const errors: ValidationError[] = [];

  if (!input.target_url || input.target_url.length > 2048) {
    errors.push({ code: 'INVALID_TARGET', message: 'target_url missing or too long' });
  }

  if (input.viewport) {
    if (!Number.isInteger(input.viewport.width) || input.viewport.width < 320 || input.viewport.width > 7680) {
      errors.push({ code: 'INVALID_VIEWPORT', message: 'viewport.width must be between 320 and 7680' });
    }
    if (!Number.isInteger(input.viewport.height) || input.viewport.height < 200 || input.viewport.height > 4320) {
      errors.push({ code: 'INVALID_VIEWPORT', message: 'viewport.height must be between 200 and 4320' });
    }
  }

  if (input.max_steps !== undefined && (!Number.isInteger(input.max_steps) || input.max_steps <= 0 || input.max_steps > 50000)) {
    errors.push({ code: 'INVALID_MAX_STEPS', message: 'max_steps must be 1..50000' });
  }

  if (input.max_duration_ms !== undefined && (!Number.isInteger(input.max_duration_ms) || input.max_duration_ms < 1000)) {
    errors.push({ code: 'INVALID_DURATION', message: 'max_duration_ms must be >= 1000' });
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateAction(input: ActionInput): ValidationResult {
  const errors: ValidationError[] = [];
  const actionTypes: AgentAction[] = ['click', 'type', 'press', 'scroll', 'hover', 'drag', 'navigate', 'wait', 'wait_for'];

  if (!actionTypes.includes(input.action)) {
    errors.push({ code: 'INVALID_ACTION', message: `Unsupported action: ${input.action}` });
  }

  if (input.action === 'navigate') {
    if (!input.url) {
      errors.push({ code: 'MISSING_URL', message: 'navigate requires url' });
    } else {
      const urlValidation = validateUrl(input.url);
      if (!urlValidation.ok) {
        errors.push(...urlValidation.errors);
      }
    }
  }

  if (input.action === 'type' && input.text == null) {
    errors.push({ code: 'MISSING_TEXT', message: 'type requires text' });
  }

  if (input.action === 'press') {
    if (!input.key) {
      errors.push({ code: 'MISSING_KEY', message: 'press requires key' });
    }
  }

  const coordAction = new Set<AgentAction>(['click', 'hover', 'drag', 'type']);
  if (coordAction.has(input.action) && !input.selector && (input.x == null || input.y == null)) {
    if (input.action === 'drag' && (input.delta_x == null || input.delta_y == null)) {
      errors.push({ code: 'MISSING_TARGET', message: 'drag requires x/y start coordinates and delta_x/delta_y' });
    } else {
      errors.push({ code: 'MISSING_TARGET', message: `${input.action} needs selector or x/y` });
    }
  }

  if (input.selector !== undefined && input.selector.length > 3000) {
    errors.push({ code: 'INVALID_SELECTOR', message: 'selector is too long' });
  }

  if (input.timeout_ms !== undefined && (!Number.isInteger(input.timeout_ms) || input.timeout_ms < 50 || input.timeout_ms > 120000)) {
    errors.push({ code: 'INVALID_TIMEOUT', message: 'timeout_ms must be 50..120000' });
  }

  if (input.max_actions_per_step !== undefined && (!Number.isInteger(input.max_actions_per_step) || input.max_actions_per_step < 1 || input.max_actions_per_step > 20)) {
    errors.push({ code: 'INVALID_ACTION_LIMIT', message: 'max_actions_per_step must be 1..20' });
  }

  return { ok: errors.length === 0, errors };
}

export function maskSecrets(value?: string | null): string {
  if (!value) {
    return '';
  }
  if (value.length <= 6) {
    return '***';
  }
  const visible = value.slice(0, 3);
  const masked = '*'.repeat(Math.max(2, value.length - 3));
  return `${visible}${masked}`;
}
