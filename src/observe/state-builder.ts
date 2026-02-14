import crypto from 'crypto';
import { Page } from 'playwright';
import { CaptureCoordinator } from '../capture/cdp.js';
import { FrameRef, NetworkEvent, StatePacket } from '../types.js';

export interface ObserveOptions {
  includeDom: boolean;
  includeAx: boolean;
  includeNetwork: boolean;
  includeFrame: boolean;
  maxFrames?: number;
}

export class StateBuilder {
  private lastStateToken = '';

  constructor(
    private readonly page: Page,
    private readonly captureCoordinator: CaptureCoordinator,
    private readonly networkRing: NetworkEvent[],
  ) {}

  async buildStateSnapshot(options: ObserveOptions): Promise<StatePacket> {
    const url = this.page.url();
    const title = await this.page.title().catch(() => '');

    const domSummary = options.includeDom ? await this.buildDomSummary() : undefined;
    const accessibility = options.includeAx
      ? await (this.page as { accessibility?: { snapshot: (options?: { interestingOnly?: boolean }) => Promise<unknown> } }).accessibility
        ?.snapshot({ interestingOnly: true })
        .catch(() => null)
      : undefined;
    const network = options.includeNetwork ? [...this.networkRing.slice(-100)] : [];
    const frameLimit = options.includeFrame ? Math.max(1, options.maxFrames ?? 6) : 0;
    const frameRefs = options.includeFrame ? this.captureCoordinator.getQueue().slice(-frameLimit) : [];

    const tokenSeed = JSON.stringify({
      url,
      title,
      dom: domSummary
        ? {
            interactive_count: domSummary.interactive_count,
            buttons: domSummary.buttons,
            text_inputs: domSummary.text_inputs,
            links: domSummary.links,
            iframes: domSummary.iframes,
            canvas_nodes: domSummary.canvas_nodes,
          }
        : {},
      networkCount: network.length,
      frameCount: frameRefs.length,
    });

    const stateToken = crypto.createHash('sha1').update(tokenSeed).digest('hex');
    const changeTokens = this.computeChangeTokens(this.lastStateToken, stateToken);
    this.lastStateToken = stateToken;

    const regionDetections = domSummary
      ? domSummary.top_elements
          .filter((element) => !!element.bounds)
          .map((element) => ({
            label: `${element.tag}${element.id ? `#${element.id}` : ''}`,
            confidence: 0.78,
            bounds: element.bounds as {
              x: number;
              y: number;
              width: number;
              height: number;
            },
          }))
      : [];

    return {
      state_token: stateToken,
      timestamp: Date.now(),
      session_id: 'unknown',
      url,
      title,
      dom: domSummary,
      accessibility,
      network_events: network,
      frame_refs: this.normalizeFrameRefs(frameRefs),
      region_detections: regionDetections,
      change_tokens: changeTokens,
      queue_health: {
        frame_queue_depth: this.captureCoordinator.getQueueDepth(),
        frame_queue_max: this.captureCoordinator.getQueueMax(),
        dropped_frames: this.captureCoordinator.getDroppedFrames(),
        pending_frames: this.captureCoordinator.getPendingFrames(),
      },
    };
  }

  withSessionId(state: StatePacket, sessionId: string): StatePacket {
    return {
      ...state,
      session_id: sessionId,
      queue_health: {
        ...state.queue_health,
      },
    };
  }

  private computeChangeTokens(previous: string, current: string): string[] {
    if (!previous) {
      return ['INIT'];
    }
    if (previous === current) {
      return ['NO_CHANGE'];
    }
    return ['STATE_CHANGED'];
  }

  private normalizeFrameRefs(refs: FrameRef[]): FrameRef[] {
    return refs.map((frame) => ({
      id: frame.id,
      timestamp: frame.timestamp,
      width: frame.width,
      height: frame.height,
      mime: frame.mime,
      checksum: frame.checksum,
      storage_path: frame.storage_path,
      metadata: frame.metadata,
    }));
  }

  private async buildDomSummary(): Promise<{ interactive_count: number; text_inputs: number; buttons: number; links: number; iframes: number; canvas_nodes: number; top_elements: Array<{ tag: string; id?: string; name?: string; role?: string; text?: string; bounds?: { x: number; y: number; width: number; height: number } }> }> {
    const result = await this.page.evaluate(() => {
      const query =
        'button, input, textarea, select, a, [role="button"], [role="link"], [onclick], canvas';
      const interactive = Array.from(document.querySelectorAll(query));
      const top = interactive.slice(0, 12).map((node) => {
        const element = node as Element;
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.getAttribute('id') || undefined,
          name: element.getAttribute('name') || undefined,
          role: element.getAttribute('role') || undefined,
          text: (element.textContent || '').trim().slice(0, 64),
          bounds: {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
          },
        };
      });

      return {
        interactive_count: interactive.length,
        text_inputs: document.querySelectorAll('input, textarea').length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        links: document.querySelectorAll('a, [role="link"]').length,
        iframes: document.querySelectorAll('iframe').length,
        canvas_nodes: document.querySelectorAll('canvas').length,
        top_elements: top,
      };
    });

    return {
      interactive_count: result.interactive_count,
      text_inputs: result.text_inputs,
      buttons: result.buttons,
      links: result.links,
      iframes: result.iframes,
      canvas_nodes: result.canvas_nodes,
      top_elements: result.top_elements,
    };
  }
}
