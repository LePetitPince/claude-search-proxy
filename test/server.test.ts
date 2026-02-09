/**
 * Integration tests for ProxyServer.
 * Uses dependency injection to mock the Claude executor,
 * so we test the full HTTP stack without calling the real CLI.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import type { ProxyConfig, ClaudeResult } from '../src/types.js';
import { ProxyServer } from '../src/server.js';

// Random port to avoid conflicts
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 30000);
}

// HTTP request helper
async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });

    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Mock result factory */
function mockClaudeResult(text = 'Mock search result'): ClaudeResult {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 500,
    result: text,
    session_id: 'mock-session',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }
  };
}

describe('ProxyServer', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];

  afterEach(async () => {
    // Clean up any servers
    await Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r()))));
    servers.length = 0;
  });

  async function startServer(
    config: Partial<ProxyConfig> = {},
    mockResult?: ClaudeResult
  ): Promise<{ port: number; server: ProxyServer }> {
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

    return { port, server };
  }

  it('should respond to GET /health', async () => {
    const { port } = await startServer();
    const res = await request(port, 'GET', '/health');

    assert.strictEqual(res.status, 200);
    const health = JSON.parse(res.body);
    assert.strictEqual(health.status, 'ok');
    assert.ok(health.timestamp);
    assert.strictEqual(health.config.model, 'claude-sonnet-4');
  });

  it('should handle POST /v1/chat/completions', async () => {
    const mockText = 'Tokyo has 14M people.\n\nSources:\n- [WPR](https://worldpopulationreview.com)';
    const { port } = await startServer({}, mockClaudeResult(mockText));

    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Tokyo population' }]
    });

    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.object, 'chat.completion');
    assert.strictEqual(data.choices.length, 1);
    assert.strictEqual(data.choices[0].message.role, 'assistant');
    assert.ok(data.choices[0].message.content.includes('14M'));
    assert.ok(Array.isArray(data.citations));
    assert.ok(data.citations.length > 0);
    assert.ok(data.citations[0].includes('worldpopulationreview.com'));
  });

  it('should handle POST /chat/completions (no /v1 prefix)', async () => {
    const { port } = await startServer();

    const res = await request(port, 'POST', '/chat/completions', {
      messages: [{ role: 'user', content: 'test query' }]
    });

    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.object, 'chat.completion');
  });

  it('should return 400 for missing messages', async () => {
    const { port } = await startServer();

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: 'test'
    });

    assert.strictEqual(res.status, 400);
    const err = JSON.parse(res.body);
    assert.ok(err.error.message.includes('messages'));
  });

  it('should return 400 for invalid JSON body', async () => {
    const { port } = await startServer();

    // Send raw invalid JSON
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.write('{ broken json');
      req.end();
    });

    assert.strictEqual(res.status, 400);
    const err = JSON.parse(res.body);
    assert.ok(err.error.message.includes('Invalid JSON'));
  });

  it('should return 404 for unknown routes', async () => {
    const { port } = await startServer();

    const res = await request(port, 'GET', '/unknown');
    assert.strictEqual(res.status, 404);
  });

  it('should handle CORS preflight with localhost origin', async () => {
    const { port } = await startServer();

    // With a localhost origin
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'OPTIONS',
        headers: { 'Origin': 'http://localhost:3000' }
      }, (r) => {
        resolve({ status: r.statusCode!, headers: r.headers });
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.ok(res.headers['access-control-allow-methods']?.includes('POST'));
  });

  it('should block requests with non-localhost Host header (DNS rebinding)', async () => {
    const { port } = await startServer();

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: { 'Host': 'evil.attacker.com' }
      }, (r) => {
        let body = '';
        r.on('data', (chunk) => { body += chunk.toString(); });
        r.on('end', () => resolve({ status: r.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(res.status, 403);
    const err = JSON.parse(res.body);
    assert.ok(err.error.message.includes('non-localhost'));
  });

  it('should allow requests with localhost Host header (any port)', async () => {
    const { port } = await startServer();

    const res = await request(port, 'GET', '/health');
    assert.strictEqual(res.status, 200);
  });

  it('should not reflect CORS for non-localhost origins', async () => {
    const { port } = await startServer();

    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'OPTIONS',
        headers: { 'Origin': 'https://evil.com' }
      }, (r) => {
        resolve({ status: r.statusCode!, headers: r.headers });
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
  });

  it('should return 500 when executor fails', async () => {
    const port = randomPort();
    const config: ProxyConfig = {
      port,
      host: '127.0.0.1',
      model: 'claude-sonnet-4',
      maxSessionSearches: 20,
      timeout: 30000,
      verbose: false
    };

    const failExecutor = async () => { throw new Error('Claude exploded'); };
    const server = new ProxyServer(config, failExecutor);
    const httpServer = await server.start();
    servers.push(httpServer);

    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'test' }]
    });

    assert.strictEqual(res.status, 500);
    const err = JSON.parse(res.body);
    assert.ok(err.error.message.includes('Claude exploded'));
  });

  it('should reject oversized request bodies with 413', async () => {
    const { port } = await startServer();

    // Send a body larger than MAX_BODY_BYTES (1MB)
    const hugeContent = 'x'.repeat(1_100_000);
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, (r) => {
        let body = '';
        r.on('data', (chunk) => { body += chunk.toString(); });
        r.on('end', () => resolve({ status: r.statusCode!, body }));
      });
      req.on('error', () => resolve({ status: 0, body: 'connection reset' }));
      req.write(hugeContent);
      req.end();
    });

    // Should get 413 or connection reset (both acceptable for oversized body)
    assert.ok(res.status === 413 || res.status === 0, `Expected 413 or connection reset, got ${res.status}`);
  });

  it('should reject queries exceeding max length', async () => {
    const { port } = await startServer();

    const longQuery = 'a'.repeat(11_000);
    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: longQuery }]
    });

    assert.strictEqual(res.status, 400);
    const err = JSON.parse(res.body);
    assert.ok(err.error.message.includes('Query too long'));
  });

  // Queue overflow is tested in session.test.ts via SessionManager directly.
  // HTTP-level queue overflow test is impractical because pending connections
  // from the never-resolving executor would hang the test suite.

  it('should show real error messages to the operator', async () => {
    const port = randomPort();
    const config: ProxyConfig = {
      port,
      host: '127.0.0.1',
      model: 'claude-sonnet-4',
      maxSessionSearches: 20,
      timeout: 30000,
      verbose: false
    };

    const failExecutor = async () => {
      throw new Error('Claude CLI returned an error');
    };
    const server = new ProxyServer(config, failExecutor);
    const httpServer = await server.start();
    servers.push(httpServer);

    const res = await request(port, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'test' }]
    });

    assert.strictEqual(res.status, 500);
    const err = JSON.parse(res.body);
    // Operator should see the real error for debugging
    assert.ok(err.error.message.includes('Claude CLI returned an error'));
  });
});
