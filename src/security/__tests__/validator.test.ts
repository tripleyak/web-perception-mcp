import { describe, expect, it } from 'vitest';

import {
  maskSecrets,
  validateAction,
  validateSessionCreate,
  validateUrl,
} from '../validator.js';

describe('validator helpers', () => {
  it('accepts a valid action with coordinates', () => {
    const result = validateAction({
      session_id: 's1',
      action: 'click',
      x: 20,
      y: 15,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid action payloads with concrete error codes', () => {
    const missingText = validateAction({
      session_id: 's1',
      action: 'type',
      selector: '#q',
    });
    expect(missingText.ok).toBe(false);
    expect(missingText.errors.map((error) => error.code)).toContain('MISSING_TEXT');

    const invalidPress = validateAction({
      session_id: 's1',
      action: 'press',
    });
    expect(invalidPress.ok).toBe(false);
    expect(invalidPress.errors.map((error) => error.code)).toContain('MISSING_KEY');

    const badLimit = validateAction({
      session_id: 's1',
      action: 'wait',
      max_actions_per_step: 0,
    });
    expect(badLimit.ok).toBe(false);
    expect(badLimit.errors.map((error) => error.code)).toContain('INVALID_ACTION_LIMIT');
  });

  it('validates URL schemes and session payload constraints', () => {
    const badUrl = validateUrl('ftp://example.com');
    expect(badUrl.ok).toBe(false);
    expect(badUrl.errors[0]?.code).toBe('INVALID_SCHEME');

    const badSession = validateSessionCreate({
      target_url: 'https://example.com',
      max_steps: 0,
      max_duration_ms: 500,
    });

    expect(badSession.ok).toBe(false);
    const codes = badSession.errors.map((error) => error.code);
    expect(codes).toContain('INVALID_MAX_STEPS');
    expect(codes).toContain('INVALID_DURATION');
  });

  it('masks secrets consistently', () => {
    expect(maskSecrets(undefined)).toBe('');
    expect(maskSecrets('abc')).toBe('***');
    expect(maskSecrets('supersecret')).toBe('sup********');
  });
});
