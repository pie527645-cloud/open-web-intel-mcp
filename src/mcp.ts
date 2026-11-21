#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

interface McpCliFlags {
  http: boolean;
  port: number;
  host: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  help: boolean;
  version: boolean;
}

/** Options for `startHttpMcpServer`. */
export interface StartHttpMcpOptions {
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

function splitCsvEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseMcpFlags(argv: string[]): McpCliFlags {
  let http = false;
  let port = Number(process.env['PORT'] ?? 3000);
  let host = process.env['HOST'] ?? '127.0.0.1';
  const allowedHosts = splitCsvEnv(process.env['ALLOWED_HOSTS']);
  const allowedOrigins = splitCsvEnv(process.env['ALLOWED_ORIGINS']);
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--http') {
      http = true;
    } else if (arg === '--port' || arg === '-p') {
      const val = Number(argv[i + 1]);
      if (!Number.isInteger(val) || val < 1 || val > 65535) {
        throw new Error(`Invalid --port value: ${argv[i + 1] ?? ''}`);
      }
      port = val;
      i += 1;
    } else if (arg.startsWith('--port=')) {
      const val = Number(arg.slice('--port='.length));
      if (!Number.isInteger(val) || val < 1 || val > 65535) {
        throw new Error(`Invalid --port value: ${arg}`);
      }
      port = val;
    } else if (arg === '--host') {
      const val = argv[i + 1];
      if (!val) throw new Error('Missing value for --host');
      host = val;
      i += 1;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--allowed-hosts') {
      const val = argv[i + 1];
      if (!val) throw new Error('Missing value for --allowed-hosts');
      allowedHosts.push(...splitCsvEnv(val));
      i += 1;
    } else if (arg.startsWith('--allowed-hosts=')) {
      allowedHosts.push(...splitCsvEnv(arg.slice('--allowed-hosts='.length)));
    } else if (arg === '--allowed-origins') {
      const val = argv[i + 1];
      if (!val) throw new Error('Missing value for --allowed-origins');
      allowedOrigins.push(...splitCsvEnv(val));
      i += 1;
    } else if (arg.startsWith('--allowed-origins=')) {
      allowedOrigins.push(...splitCsvEnv(arg.slice('--allowed-origins='.length)));
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { http, port, host, allowedHosts, allowedOrigins, help, version };
}

function printMcpHelp(): void {
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION}\n\n` +
      `Usage:\n` +
      `  open-web-intel-mcp                        Start MCP server over stdio (default)\n` +
      `  open-web-intel-mcp --http [--port 3000]   Start stateless Streamable HTTP MCP server\n\n` +
      `Options:\n` +
      `  --http                   Enable stateless Streamable HTTP transport at /mcp\n` +
      `  --port, -p <port>        HTTP listen port (default: 3000)\n` +
      `  --host <addr>            HTTP bind address (default: 127.0.0.1)\n` +
      `  --allowed-hosts <csv>    Additional allowed Host header values (or ALLOWED_HOSTS env)\n` +
      `  --allowed-origins <csv>  Additional allowed Origin values (or ALLOWED_ORIGINS env)\n` +
      `  --help, -h               Show help message\n` +
      `  --version, -v            Show server version\n`,
  );
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function validateOriginAndHostHeaders(
  req: IncomingMessage,
  boundHost: string,
  activePort: number,
  extraHosts: readonly string[],
  extraOrigins: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const hostSet = new Set<string>([
    '127.0.0.1',
    `127.0.0.1:${activePort}`,
    'localhost',
    `localhost:${activePort}`,
    '[::1]',
    `[::1]:${activePort}`,
    ...extraHosts,
  ]);

  const normalizedBind = boundHost.trim().toLowerCase();
  if (
    normalizedBind &&
    normalizedBind !== '0.0.0.0' &&
    normalizedBind !== '::' &&
    normalizedBind !== '::1'
  ) {
    const bracketed = normalizedBind.includes(':') && !normalizedBind.startsWith('[')
      ? `[${normalizedBind}]`
      : normalizedBind;
    hostSet.add(bracketed);
    hostSet.add(`${bracketed}:${activePort}`);
  }

  const rawHost = req.headers.host?.trim().toLowerCase();
  if (!rawHost) {
    return { ok: false, reason: 'Forbidden: missing Host header' };
  }
  if (!hostSet.has('*') && !hostSet.has(rawHost)) {
    return { ok: false, reason: `Forbidden: untrusted Host header "${rawHost}"` };
  }

  const rawOriginHeader = req.headers.origin;
  if (rawOriginHeader !== undefined) {
    const rawOrigin = (Array.isArray(rawOriginHeader) ? rawOriginHeader[0] : rawOriginHeader)?.trim();
    if (!rawOrigin) {
      return { ok: false, reason: 'Forbidden: empty Origin header' };
    }

    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(rawOrigin);
    } catch {
      return { ok: false, reason: `Forbidden: malformed Origin header "${rawOrigin}"` };
    }

    if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
      return { ok: false, reason: `Forbidden: disallowed Origin scheme "${parsedOrigin.protocol}"` };
    }

    const originFull = parsedOrigin.origin.toLowerCase();
    const originHostname = parsedOrigin.hostname.toLowerCase();
    const originAllowed =
      LOOPBACK_HOSTNAMES.has(originHostname) ||
      extraOrigins.includes('*') ||
      extraOrigins.includes(originFull) ||
      extraOrigins.includes(originHostname);

    if (!originAllowed) {
      return { ok: false, reason: `Forbidden: untrusted Origin "${rawOrigin}"` };
    }
  }

  return { ok: true };
}

/**
 * Starts the stateless Streamable HTTP MCP server bound to `host:port`,
 * enforcing DNS-rebinding `Host` and `Origin` header validation before handling requests.
 */
export async function startHttpMcpServer(
  port = 3000,
  host = '127.0.0.1',
  options: StartHttpMcpOptions = {},
) {
  const extraHosts = [
    ...splitCsvEnv(process.env['ALLOWED_HOSTS']),
    ...(options.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
  ];
  const extraOrigins = [
    ...splitCsvEnv(process.env['ALLOWED_ORIGINS']),
    ...(options.allowedOrigins ?? []).map((o) => o.trim().toLowerCase()).filter(Boolean),
  ];

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const addr = httpServer.address();
    const activePort = typeof addr === 'object' && addr ? addr.port : port;

    const securityCheck = validateOriginAndHostHeaders(
      req,
      host,
      activePort,
      extraHosts,
      extraOrigins,
    );
    if (!securityCheck.ok) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: securityCheck.reason },
          id: null,
        }),
      );
      return;
    }

    const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (req.method === 'GET' && reqUrl.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          server: SERVER_NAME,
          version: SERVER_VERSION,
          tools: 7,
        }),
      );
      return;
    }

    if (reqUrl.pathname === '/mcp') {
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on('close', () => {
        transport.close().catch(() => undefined);
        mcpServer.close().catch(() => undefined);
      });

      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message },
              id: null,
            }),
          );
        }
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found. Use POST /mcp or GET /health.' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });

  return httpServer;
}

async function main(): Promise<void> {
  let flags: McpCliFlags;
  try {
    flags = parseMcpFlags(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(2);
  }

  if (flags.help) {
    printMcpHelp();
    return;
  }

  if (flags.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  if (flags.http) {
    const httpServer = await startHttpMcpServer(flags.port, flags.host, {
      allowedHosts: flags.allowedHosts,
      allowedOrigins: flags.allowedOrigins,
    });
    const addr = httpServer.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : flags.port;
    process.stderr.write(
      `${SERVER_NAME} v${SERVER_VERSION} listening on http://${flags.host}:${actualPort}/mcp\n`,
    );

    const shutdown = () => {
      const forceExit = setTimeout(() => process.exit(1), 10_000);
      forceExit.unref();
      httpServer.close(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return entry.endsWith('mcp.js') || entry.endsWith('open-web-intel-mcp');
  }
}

if (isMainModule()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exit(1);
  });
}
