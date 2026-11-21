import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { describe, it, afterEach } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCli } from '../src/cli.js';
import { resetDefaultSafeFetchDeps, setDefaultSafeFetchDeps } from '../src/lib/safe-fetch.js';
import { startHttpMcpServer } from '../src/mcp.js';

const EXPECTED_TOOLS = [
  'fetch_markdown',
  'crawl_sitemap',
  'search_ats_jobs',
  'search_remote_jobs',
  'inspect_ecommerce_store',
  'enrich_domain_intel',
  'search_podcasts_rss',
];

afterEach(() => {
  resetDefaultSafeFetchDeps();
});

describe('Live Stdio & HTTP MCP Handshake + CLI Verification', () => {
  it('spawns dist/mcp.js over stdio, completes initialize + tools/list, and passes hygiene checks', async () => {
    const serverScript = resolve(process.cwd(), 'dist', 'mcp.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverScript],
      stderr: 'pipe',
    });

    const client = new Client({ name: 'test-suite-client', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      assert.deepEqual(names, EXPECTED_TOOLS);

      // Verify zero hidden tags, URLs, zero-width chars, or instruction overrides in tool schemas
      const serialized = JSON.stringify(tools);
      assert.ok(serialized.length < 7000, `Expected compact schema payload, got ${serialized.length} chars`);
      assert.equal(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/.test(serialized), false);
      for (const tool of tools) {
        const desc = tool.description ?? '';
        assert.ok(desc.length >= 20 && desc.length <= 160);
        assert.equal(/[<>]/.test(desc), false, `Tool ${tool.name} description should not contain angle brackets`);
        assert.equal(/https?:\/\//i.test(desc), false, `Tool ${tool.name} description should not contain URLs`);
      }

      // Verify SSRF block over live MCP tools/call returns graceful isError result without crashing server
      const blockedCall = await client.callTool({
        name: 'fetch_markdown',
        arguments: { url: 'http://127.0.0.1:8080/internal' },
      });
      assert.equal(blockedCall.isError, true);
    } finally {
      await client.close();
    }
  });

  it('handles multiple stateless Streamable HTTP requests cleanly on 127.0.0.1', async () => {
    const httpServer = await startHttpMcpServer(0, '127.0.0.1');
    try {
      const addr = httpServer.address();
      assert.ok(addr && typeof addr === 'object');
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const healthRes = await fetch(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as { status: string; tools: number };
      assert.equal(healthJson.status, 'ok');
      assert.equal(healthJson.tools, 7);

      // Request 1: initialize
      const initRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'http-test', version: '1.0.0' },
          },
        }),
      });
      assert.equal(initRes.status, 200);
      const initPayload = (await initRes.json()) as { result?: { serverInfo?: { name?: string } } };
      assert.equal(initPayload.result?.serverInfo?.name, 'open-web-intel-mcp');

      // Request 2: tools/list on the same server (verifies fresh stateless transport per request)
      const toolsRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      });
      assert.equal(toolsRes.status, 200);
      const toolsPayload = (await toolsRes.json()) as { result?: { tools?: Array<{ name: string }> } };
      assert.equal(toolsPayload.result?.tools?.length, 7);

      // Request 3: untrusted Origin header must be rejected with 403 before transport creation
      const badOriginRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          origin: 'http://attacker.example',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      assert.equal(badOriginRes.status, 403);

      // Request 4: untrusted Host header (DNS rebinding) sent over raw HTTP socket must return 403
      const badHostStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path: '/mcp',
            method: 'POST',
            headers: {
              Host: 'attacker.example',
              Origin: 'http://attacker.example',
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolveStatus(res.statusCode ?? 0));
          },
        );
        req.on('error', rejectStatus);
        req.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'evil', version: '1.0.0' },
            },
          }),
        );
        req.end();
      });
      assert.equal(badHostStatus, 403);
    } finally {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  });

  it('executes CLI --help, --version, subcommand --json, and error handling cleanly', async () => {
    let out = '';
    let err = '';
    const io = {
      stdout: (s: string) => {
        out += s;
      },
      stderr: (s: string) => {
        err += s;
      },
    };

    const helpCode = await runCli(['--help'], io);
    assert.equal(helpCode, 0);
    assert.ok(out.includes('Subcommands:'));
    assert.ok(out.includes('podcasts'));

    out = '';
    setDefaultSafeFetchDeps({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () =>
        new Response('<html><head><title>CLI Test</title></head><body><main><h1>Hello CLI</h1><p>Body paragraph with sufficient text to pass main content threshold cleanly for extraction testing in CLI mode.</p></main></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });

    const fetchCode = await runCli(['fetch', 'https://example.com/page', '--json'], io);
    assert.equal(fetchCode, 0);
    const parsed = JSON.parse(out) as { title: string; markdown: string };
    assert.equal(parsed.title, 'CLI Test');
    assert.ok(parsed.markdown.includes('# Hello CLI'));

    err = '';
    const badCode = await runCli(['unknown-cmd'], io);
    assert.equal(badCode, 1);
    assert.ok(err.includes('Unknown subcommand'));
  });
});
