import { Locator, Page } from 'playwright';
import { ActionInput, ActionResult, NetworkEvent } from '../types.js';

export interface ActionExecutorDependencies {
  maxActionsPerStep: number;
}

export class ActionExecutor {
  constructor(private readonly page: Page) {}

  async execute(input: ActionInput, networkRing: NetworkEvent[]): Promise<ActionResult> {
    const action = input.action;
    const timeout = Math.min(Math.max(input.timeout_ms ?? 8000, 100), 120000);
    const start = Date.now();

    const maxActions = input.max_actions_per_step ?? 1;
    if (maxActions < 1 || maxActions > 1) {
      return {
        action,
        success: false,
        status: 'rejected',
        detail: 'max_actions_per_step must be 1 in phase 1',
      };
    }

    try {
      const result = await this.withTimeout(() => this.dispatch(action, input, timeout), timeout + 300);
      this.recordActionEvent(input, networkRing, result, true);
      return {
        action,
        success: true,
        status: 'completed',
        target: this.page.url(),
        selector: result?.selector,
        coordinates: result?.coordinates,
        elapsed_ms: Date.now() - start,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'action failed';
      this.recordActionEvent(input, networkRing, undefined, false, message);
      return {
        action,
        success: false,
        status: 'failed',
        detail: message,
        elapsed_ms: Date.now() - start,
      };
    }
  }

  private async dispatch(
    action: ActionInput['action'],
    input: ActionInput,
    timeout: number,
  ): Promise<{ selector?: string; coordinates?: { x: number; y: number } }> {
    switch (action) {
      case 'navigate': {
        if (!input.url) {
          throw new Error('navigate requires url');
        }
        await this.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout });
        return {};
      }

      case 'click': {
        return this.withElementOrCoordinate(input, async (locator) => {
          await locator.waitFor({ state: 'visible', timeout });
          await locator.first().click({ timeout });
          return { selector: input.selector };
        }, async (x, y) => {
          await this.page.mouse.click(x, y);
          return { coordinates: { x, y } };
        });
      }

      case 'hover': {
        return this.withElementOrCoordinate(input, async (locator) => {
          await locator.first().hover({ timeout });
          return { selector: input.selector };
        }, async (x, y) => {
          await this.page.mouse.move(x, y);
          return { coordinates: { x, y } };
        });
      }

      case 'type': {
        if (!input.text) {
          throw new Error('type requires text');
        }
        return this.withElementOrCoordinate(input, async (locator) => {
          await locator.first().scrollIntoViewIfNeeded();
          await locator.first().fill(input.text ?? '', { timeout });
          return { selector: input.selector };
        }, async (x, y) => {
          await this.page.mouse.move(x, y);
          await this.page.mouse.click(x, y);
          await this.page.keyboard.type(input.text ?? '');
          return { coordinates: { x, y } };
        });
      }

      case 'press': {
        if (!input.key) {
          throw new Error('press requires key');
        }
        await this.page.keyboard.press(input.key, { delay: 20 });
        return {};
      }

      case 'scroll': {
        if (input.x !== undefined && input.y !== undefined) {
          await this.page.mouse.move(input.x, input.y);
        }
        await this.page.mouse.wheel(input.delta_x ?? 0, input.delta_y ?? 0);
        return {};
      }

      case 'drag': {
        if (input.x == null || input.y == null || input.delta_x == null || input.delta_y == null) {
          throw new Error('drag requires x, y, delta_x, delta_y');
        }
        await this.page.mouse.move(input.x, input.y);
        await this.page.mouse.down();
        await this.page.mouse.move(input.x + input.delta_x, input.y + input.delta_y, { steps: 10 });
        await this.page.mouse.up();
        return { coordinates: { x: input.x, y: input.y } };
      }

      case 'wait': {
        const waitMs = Math.min(input.timeout_ms ?? 1000, 120000);
        await this.page.waitForTimeout(waitMs);
        return {};
      }

      case 'wait_for': {
        const waitFor = input.wait_for || '';
        if (!waitFor) {
          throw new Error('wait_for requires a selector or wait strategy');
        }

        const normalized = waitFor.toLowerCase().trim();
        if (normalized === 'networkidle' || normalized === 'network_idle') {
          await this.page.waitForLoadState('networkidle', { timeout });
          return {};
        }

        if (normalized === 'domstable' || normalized === 'stable') {
          await this.page.waitForLoadState('domcontentloaded', { timeout });
          return {};
        }

        await this.page.waitForSelector(waitFor, { timeout });
        return {};
      }

      default:
        throw new Error(`unsupported action: ${action}`);
    }
  }

  private async withElementOrCoordinate(
    input: ActionInput,
    withSelector: (locator: Locator) => Promise<{ selector?: string; coordinates?: { x: number; y: number } }>,
    withCoords: (x: number, y: number) => Promise<{ selector?: string; coordinates?: { x: number; y: number } }>,
  ): Promise<{ selector?: string; coordinates?: { x: number; y: number } }> {
    if (input.selector) {
      const locator = this.page.locator(input.selector);
      const count = await locator.count();
      if (count > 0) {
        return withSelector(locator);
      }
    }

    if (input.x == null || input.y == null) {
      throw new Error('selector not found and coordinates missing');
    }

    return withCoords(input.x, input.y);
  }

  private recordActionEvent(
    input: ActionInput,
    networkRing: NetworkEvent[],
    result?: { selector?: string; coordinates?: { x: number; y: number } },
    success = true,
    detail?: string,
  ): void {
    networkRing.push({
      id: `${Date.now()}:${input.action}`,
      url: this.page.url(),
      method: input.action,
      status: success ? 200 : 0,
      type: result ? 'action' : 'action_failed',
      time: Date.now(),
      failureText: success ? undefined : detail,
    });
    if (networkRing.length > 400) {
      networkRing.shift();
    }
  }

  private withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`action timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      fn()
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
