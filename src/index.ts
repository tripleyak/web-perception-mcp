import { randomUUID } from 'crypto';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MetricsCollector } from './telemetry/metrics.js';
import { SessionManager } from './session/session-manager.js';
import { PolicyMode } from './types.js';
import { ToolHandler } from './tools.js';
import { RestAdapter } from './adapters/rest.js';

const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_HEADLESS = true;

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.floor(value);
}

function parsePolicyMode(raw: string | undefined): PolicyMode {
  if (raw === 'deterministic' || raw === 'model_owns_action') {
    return raw;
  }
  return 'model_owns_action';
}

async function startStdioServer(handler: ToolHandler): Promise<void> {
  const server = new Server({
    name: 'web-perception-agent-mcp',
    version: '0.1.0',
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: handler.listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments as Record<string, unknown> | undefined;

    try {
      const result = await callTool(handler, name, args ?? {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : 'tool execution failed',
            }),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function callTool(handler: ToolHandler, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'web_agent_session_create':
      return handler.create(args);
    case 'web_agent_step':
      return handler.step(args);
    case 'web_agent_snapshot':
      return handler.snapshot(args);
    case 'web_agent_session_stop':
      return handler.stop(args);
    case 'web_agent_replay':
      return handler.replay(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main(): Promise<void> {
  const metrics = new MetricsCollector();
  const transport = process.env.MCP_TRANSPORT?.toLowerCase() || 'stdio';

  const sessionManager = new SessionManager(metrics, {
    maxSessions: parseIntEnv('MCP_MAX_SESSIONS', DEFAULT_MAX_SESSIONS),
    headless: process.env.MCP_HEADLESS?.toLowerCase() !== 'false' ? DEFAULT_HEADLESS : false,
    allowedDomains: parseCsv(process.env.WEB_AGENT_ALLOWLIST),
    deniedDomains: parseCsv(process.env.WEB_AGENT_DENYLIST),
    policyMode: parsePolicyMode(process.env.WEB_AGENT_POLICY),
    sessionMaxAgeMs: parseIntEnv('WEB_AGENT_MAX_SESSION_AGE_MS', 30 * 60 * 1000),
  });

  const toolHandler = new ToolHandler(sessionManager);

  setInterval(() => {
    sessionManager
      .gc()
      .catch(() => undefined);
  }, 30_000);

  if (transport === 'http' || transport === 'rest') {
    const host = process.env.WEB_AGENT_REST_HOST || '0.0.0.0';
    const port = parseIntEnv('WEB_AGENT_REST_PORT', 3400);
    const adapter = new RestAdapter(toolHandler, { host, port });
    await adapter.start();
    return;
  }

  await startStdioServer(toolHandler);
}

void main().catch((error) => {
  console.error('web-perception-agent-mcp fatal', {
    error: error instanceof Error ? error.message : String(error),
    instance_id: randomUUID(),
  });
  process.exit(1);
});
