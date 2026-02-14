import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { BrowserContext, CDPSession, Page } from 'playwright';
import { MetricsCollector } from '../telemetry/metrics.js';
import { FrameRef } from '../types.js';

export interface RingBuffer<T> {
  push(value: T): void;
  popOldest(): T | undefined;
  getAll(): T[];
  depth(): number;
  clear(): void;
  maxDepth: number;
  dropped: number;
}

class FixedRingBuffer<T> implements RingBuffer<T> {
  private readonly items: T[] = [];
  public dropped = 0;

  constructor(public readonly maxDepth: number) {}

  push(value: T): void {
    this.items.push(value);
    while (this.items.length > this.maxDepth) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  popOldest(): T | undefined {
    return this.items.shift();
  }

  getAll(): T[] {
    return [...this.items];
  }

  depth(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

export interface FrameOptions {
  enabled: boolean;
  traceId: string;
  sessionId: string;
  frameQuality: number;
  maxWidth?: number;
  maxHeight?: number;
  maxFrames: number;
  adaptive: boolean;
  traceDir: string;
}

export interface CaptureCoordinatorEvents {
  onFrame?: (frame: FrameRef) => void;
}

export interface CaptureCoordinatorOptions {
  page: Page;
  context: BrowserContext;
  options: FrameOptions;
  events?: CaptureCoordinatorEvents;
  metrics?: MetricsCollector;
}

export class CaptureCoordinator {
  private readonly frameBuffer: RingBuffer<FrameRef>;
  private frameEventHandler?: (payload: unknown) => Promise<void>;
  private cdpSession?: CDPSession;
  private active = false;
  private pendingAcks = 0;
  private lastCaptureMs = 0;
  private burstUntilMs = 0;
  private cdpFrameSeq = 0;
  private detached = false;
  private lastDroppedFrames = 0;

  constructor(private readonly cfg: CaptureCoordinatorOptions) {
    this.frameBuffer = new FixedRingBuffer<FrameRef>(Math.max(1, cfg.options.maxFrames));
  }

  async start(): Promise<void> {
    if (!this.cfg.options.enabled || this.active) {
      return;
    }

    this.cdpSession = await this.cfg.context.newCDPSession(this.cfg.page);
    this.active = true;
    this.detached = false;

    this.frameEventHandler = async (payload: unknown) => {
      const framePayload = payload as {
        sessionId?: string;
        data?: string;
        metadata?: { deviceWidth?: number; deviceHeight?: number; timestamp?: number; scale?: number; }
      };

      if (!this.active || !framePayload) {
        if (framePayload?.sessionId) {
          await this.ackFrame(framePayload.sessionId).catch(() => undefined);
        }
        return;
      }

      this.pendingAcks += 1;
      const start = Date.now();
      const sessionId = framePayload.sessionId;

      try {
        const shouldCapture = this.shouldCaptureFrame(start);
        if (sessionId && shouldCapture && framePayload.data) {
          const metadata = framePayload.metadata ?? {};
          const width = metadata.deviceWidth ?? this.cfg.options.maxWidth ?? 0;
          const height = metadata.deviceHeight ?? this.cfg.options.maxHeight ?? 0;
          const frameId = `${this.cfg.options.sessionId}-${Date.now()}-${this.cdpFrameSeq += 1}`;
          const framePath = path.join(this.cfg.options.traceDir, 'frames', `${frameId}.jpg`);
          await fs.mkdir(path.dirname(framePath), { recursive: true });

          const buffer = Buffer.from(framePayload.data, 'base64');
          await fs.writeFile(framePath, buffer);

          const checksum = crypto.createHash('sha1').update(buffer).digest('hex');
          const ref: FrameRef = {
            id: frameId,
            timestamp: Date.now(),
            width,
            height,
            mime: 'image/jpeg',
            checksum,
            storage_path: framePath,
            metadata: {
              scale: metadata.scale,
              raw_length: buffer.length,
              processing_ms: Date.now() - start,
            },
          };

          this.frameBuffer.push(ref);
          this.cfg.events?.onFrame?.(ref);
          if (this.cfg.metrics) {
            const droppedNow = this.frameBuffer.dropped;
            this.cfg.metrics.recordFrameDrops(Math.max(0, droppedNow - this.lastDroppedFrames));
            this.lastDroppedFrames = droppedNow;
          }
        }
      } finally {
        if (sessionId) {
          await this.ackFrame(sessionId).catch(() => undefined);
        }
        this.pendingAcks -= 1;
      }
    };

    this.cdpSession.on('Page.screencastFrame', this.frameEventHandler);

    await this.cdpSession.send('Page.enable');
    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.cfg.options.frameQuality,
      maxWidth: this.cfg.options.maxWidth,
      maxHeight: this.cfg.options.maxHeight,
      everyNthFrame: 1,
    });
  }

  async stop(): Promise<void> {
    if (!this.active || !this.cdpSession) {
      this.active = false;
      return;
    }

    this.active = false;
    try {
      await this.cdpSession.send('Page.stopScreencast');
    } catch {
      // best effort
    }

    try {
      await this.cdpSession.detach();
    } catch {
      // best effort
    }

    this.detached = true;
    if (this.frameEventHandler) {
      this.cdpSession.removeListener('Page.screencastFrame', this.frameEventHandler);
      this.frameEventHandler = undefined;
    }
    this.frameBuffer.clear();
    this.pendingAcks = 0;
  }

  getQueueDepth(): number {
    return this.frameBuffer.depth();
  }

  getQueueMax(): number {
    return this.frameBuffer.maxDepth;
  }

  getDroppedFrames(): number {
    return this.frameBuffer.dropped;
  }

  getPendingFrames(): number {
    return Math.max(0, this.pendingAcks);
  }

  getQueue(): FrameRef[] {
    return this.frameBuffer.getAll();
  }

  async latestFrame(): Promise<FrameRef | null> {
    const all = this.getQueue();
    return all.at(-1) ?? null;
  }

  signalVisualDrift(): void {
    if (!this.cfg.options.adaptive) {
      return;
    }
    this.burstUntilMs = Date.now() + 2000;
  }

  private shouldCaptureFrame(nowMs: number): boolean {
    const baselineInterval = 333;
    const burstInterval = 125;
    const interval = nowMs < this.burstUntilMs ? burstInterval : baselineInterval;

    if (this.lastCaptureMs === 0) {
      this.lastCaptureMs = nowMs;
      return true;
    }

    if (nowMs - this.lastCaptureMs >= interval) {
      this.lastCaptureMs = nowMs;
      return true;
    }

    return false;
  }

  private async ackFrame(sessionId: string): Promise<void> {
    if (!this.cdpSession || this.detached) {
      return;
    }
    await this.cdpSession.send('Page.screencastFrameAck', { sessionId } as unknown as never);
  }
}
