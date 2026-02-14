import fs from 'fs/promises';
import path from 'path';
import { ReplayManifest, ReplayEvent } from '../types.js';

export const TRACE_DIR = path.resolve(process.cwd(), 'traces');

function sanitizeTraceId(traceId: string): string {
  return traceId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class ReplayStore {
  static buildTracePath(traceId: string): string {
    return path.join(TRACE_DIR, `${sanitizeTraceId(traceId)}.jsonl`);
  }

  static buildTraceIndex(traceId: string): string {
    return path.join(TRACE_DIR, `${sanitizeTraceId(traceId)}.index.json`);
  }

  static async append(traceId: string, event: ReplayEvent): Promise<void> {
    const tracePath = ReplayStore.buildTracePath(traceId);
    await fs.mkdir(TRACE_DIR, { recursive: true });
    await fs.appendFile(tracePath, `${JSON.stringify(event)}\n`);
  }

  static async load(traceId: string): Promise<ReplayManifest> {
    const tracePath = ReplayStore.buildTracePath(traceId);
    const raw = await fs.readFile(tracePath, 'utf8').catch(() => '');

    if (!raw) {
      return {
        trace_id: traceId,
        created_at: Date.now(),
        events: [],
      };
    }

    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as ReplayEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is ReplayEvent => event !== null);

    const createPayload = events.find(
      (event) =>
        event.type === 'create' && typeof (event.payload as { session_id?: unknown })?.session_id === 'string',
    ) as {
      payload: {
        session_id: string;
      };
    } | undefined;

    return {
      trace_id: traceId,
      created_at: events[0]?.at ?? Date.now(),
      session_id: createPayload?.payload?.session_id,
      events,
    };
  }

  static async filter(traceId: string, start?: number, end?: number): Promise<ReplayEvent[]> {
    const manifest = await ReplayStore.load(traceId);
    return manifest.events.filter((event) => {
      if (typeof start === 'number' && event.index < start) {
        return false;
      }
      if (typeof end === 'number' && event.index > end) {
        return false;
      }
      return true;
    });
  }

  static async persistTraceIndex(traceId: string, events: ReplayEvent[]): Promise<void> {
    const indexPath = ReplayStore.buildTraceIndex(traceId);
    await fs.mkdir(TRACE_DIR, { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify({ traceId, total: events.length, updated_at: Date.now() }, null, 2));
  }

  static async cleanup(traceId: string): Promise<void> {
    await Promise.all([fs.rm(ReplayStore.buildTracePath(traceId), { force: true }), fs.rm(ReplayStore.buildTraceIndex(traceId), { force: true })]).catch(() => {});
  }
}
