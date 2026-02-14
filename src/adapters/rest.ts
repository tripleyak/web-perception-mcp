import http from 'http';
import { ToolHandler } from '../tools.js';

interface RestAdapterConfig {
  host: string;
  port: number;
}

function jsonResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function collectBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

export class RestAdapter {
  constructor(
    private readonly handler: ToolHandler,
    private readonly config: RestAdapterConfig,
  ) {}

  async start(): Promise<void> {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      try {
        if (req.method === 'GET' && url.pathname === '/health') {
          jsonResponse(res, 200, {
            ok: true,
            transport: 'rest',
            tools: this.handler.listTools().length,
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/tools') {
          jsonResponse(res, 200, { tools: this.handler.listTools() });
          return;
        }

        if (req.method === 'POST' && url.pathname.startsWith('/tools/')) {
          const tool = url.pathname.replace('/tools/', '');
          const body = await collectBody(req);
          const args = body as Record<string, unknown>;

          const result = await this.invoke(tool, args);
          jsonResponse(res, 200, { ok: true, result });
          return;
        }

        jsonResponse(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        jsonResponse(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'internal error',
        });
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(this.config.port, this.config.host, () => resolve());
      server.on('error', reject);
    });
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'web_agent_session_create':
        return this.handler.create(args);
      case 'web_agent_step':
        return this.handler.step(args);
      case 'web_agent_snapshot':
        return this.handler.snapshot(args);
      case 'web_agent_session_stop':
        return this.handler.stop(args);
      case 'web_agent_replay':
        return this.handler.replay(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
