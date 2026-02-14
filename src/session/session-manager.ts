import crypto from 'crypto';
import { BrowserSession } from './browser-session.js';
import { createBrowserSession } from './browser-session.js';
import { createPolicyAdapter } from '../policy/policy.js';
import { getDefaultMaxFrames } from './browser-session.js';
import { validateUrl } from '../security/validator.js';
import { MetricsCollector } from '../telemetry/metrics.js';
import { CaptureProfile, CreateResult, PolicyMode, SessionCreateInput } from '../types.js';

interface SessionManagerOptions {
  maxSessions?: number;
  headless?: boolean;
  allowedDomains?: string[];
  deniedDomains?: string[];
  sessionMaxAgeMs?: number;
  traceDir?: string;
  policyMode?: PolicyMode;
}

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly created = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly defaultHeadless: boolean;
  private readonly allowedDomains: string[];
  private readonly deniedDomains: string[];
  private readonly maxAgeMs: number;
  private readonly policyMode: PolicyMode;

  constructor(
    private readonly metrics: MetricsCollector,
    options: SessionManagerOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? 5;
    this.defaultHeadless = options.headless ?? true;
    this.allowedDomains = options.allowedDomains ?? [];
    this.deniedDomains = options.deniedDomains ?? [];
    this.maxAgeMs = options.sessionMaxAgeMs ?? 1000 * 60 * 30;
    this.policyMode = options.policyMode ?? 'model_owns_action';
  }

  async create(input: SessionCreateInput): Promise<CreateResult> {
    if (this.sessions.size >= this.maxSessions) {
      const oldest = this.getOldestSessionId();
      if (oldest) {
        await this.stop(oldest, false);
      }
    }

    const urlValidation = validateUrl(input.target_url, this.allowedDomains, this.deniedDomains);
    if (!urlValidation.ok) {
      throw new Error(urlValidation.errors.map((item) => `${item.code}:${item.message}`).join('; '));
    }

    const sessionId = crypto.randomUUID();
    const traceId = `trace_${Date.now()}_${sessionId}`;
    const captureProfile: CaptureProfile = input.capture_profile ?? 'adaptive';
    const maxFrames = getDefaultMaxFrames(captureProfile, input.max_steps);
    const policy = createPolicyAdapter(input.policy ?? this.policyMode);

    const session = await createBrowserSession(sessionId, input, {
      policy,
      captureProfile,
      maxSteps: input.max_steps,
      traceId,
      headless: input.headless ?? this.defaultHeadless,
      viewport: input.viewport,
      storageState: input.storage_state,
      maxDurationMs: input.max_duration_ms,
      maxFrames,
      metrics: this.metrics,
    });

    const result = await session.start();
    this.sessions.set(sessionId, session);
    this.created.set(sessionId, Date.now());
    return result;
  }

  get(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  async stop(sessionId: string, preserveArtifacts = false): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    await session.stop(preserveArtifacts);
    this.sessions.delete(sessionId);
    this.created.delete(sessionId);
  }

  async stopAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    await Promise.all(sessionIds.map((sessionId) => this.stop(sessionId, false)));
  }

  async gc(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [sessionId, startedAt] of this.created.entries()) {
      if (now - startedAt <= this.maxAgeMs) {
        continue;
      }
      await this.stop(sessionId, false);
      removed += 1;
    }
    return removed;
  }

  getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  touch(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.created.set(sessionId, Date.now());
    }
  }

  getOldestSessionId(): string | null {
    const oldest = [...this.created.entries()].sort((a, b) => a[1] - b[1])[0];
    return oldest ? oldest[0] : null;
  }
}
