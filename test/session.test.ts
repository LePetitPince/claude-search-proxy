/**
 * Tests for SessionManager using dependency injection (mock executor)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SessionManager, type ClaudeExecutor } from '../src/session.js';
import type { ProxyConfig, ClaudeResult } from '../src/types.js';

/** Create a mock executor that returns results from a queue */
function createMockExecutor(results: ClaudeResult[]): {
  executor: ClaudeExecutor;
  calls: Array<{ query: string; sessionId: string; isFirstSearch: boolean }>;
} {
  const queue = [...results];
  const calls: Array<{ query: string; sessionId: string; isFirstSearch: boolean }> = [];

  const executor: ClaudeExecutor = async (options) => {
    calls.push({
      query: options.query,
      sessionId: options.sessionId,
      isFirstSearch: options.isFirstSearch
    });

    if (queue.length === 0) {
      throw new Error('No more mock results');
    }
    return queue.shift()!;
  };

  return { executor, calls };
}

/** Create a standard mock result */
function mockResult(text = 'Test result'): ClaudeResult {
  return {
    type: 'result',
    is_error: false,
    duration_ms: 1000,
    result: text,
    session_id: 'mock-session',
    total_cost_usd: 0.01
  };
}

const baseConfig: ProxyConfig = {
  port: 52480,
  host: '127.0.0.1',
  model: 'claude-sonnet-4',
  maxSessionSearches: 3,
  timeout: 30000,
  verbose: false
};

describe('SessionManager', () => {
  it('should start with null session', () => {
    const { executor } = createMockExecutor([]);
    const sm = new SessionManager(baseConfig, executor);
    const info = sm.getSessionInfo();

    assert.strictEqual(info.sessionId, null);
    assert.strictEqual(info.searchCount, 0);
    assert.strictEqual(info.maxSearches, 3);
  });

  it('should create a session on first search', async () => {
    const { executor, calls } = createMockExecutor([mockResult()]);
    const sm = new SessionManager(baseConfig, executor);

    await sm.execute('test query');

    const info = sm.getSessionInfo();
    assert.ok(info.sessionId !== null);
    assert.strictEqual(info.searchCount, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].isFirstSearch, true);
    assert.strictEqual(calls[0].query, 'test query');
  });

  it('should reuse session for subsequent searches', async () => {
    const { executor, calls } = createMockExecutor([mockResult(), mockResult()]);
    const sm = new SessionManager(baseConfig, executor);

    await sm.execute('query 1');
    const firstSession = sm.getSessionInfo().sessionId;

    await sm.execute('query 2');
    const secondSession = sm.getSessionInfo().sessionId;

    assert.strictEqual(firstSession, secondSession);
    assert.strictEqual(sm.getSessionInfo().searchCount, 2);

    // First search should have isFirstSearch=true, second should be false
    assert.strictEqual(calls[0].isFirstSearch, true);
    assert.strictEqual(calls[1].isFirstSearch, false);

    // Both should use same sessionId
    assert.strictEqual(calls[0].sessionId, calls[1].sessionId);
  });

  it('should rotate session after max searches', async () => {
    const { executor, calls } = createMockExecutor([
      mockResult(), mockResult(), mockResult(), mockResult()
    ]);
    const sm = new SessionManager(baseConfig, executor);

    // Fill up first session (maxSessionSearches = 3)
    await sm.execute('q1');
    await sm.execute('q2');
    await sm.execute('q3');
    const firstSession = calls[0].sessionId;

    assert.strictEqual(sm.getSessionInfo().searchCount, 3);

    // Next search should rotate
    await sm.execute('q4');
    const newSession = calls[3].sessionId;

    assert.notStrictEqual(firstSession, newSession);
    assert.strictEqual(sm.getSessionInfo().searchCount, 1);
    assert.strictEqual(calls[3].isFirstSearch, true); // New session = first search
  });

  it('should not increment count on failure', async () => {
    const executor: ClaudeExecutor = async () => {
      throw new Error('Claude failed');
    };
    const sm = new SessionManager(baseConfig, executor);

    await assert.rejects(() => sm.execute('failing query'), /Claude failed/);
    assert.strictEqual(sm.getSessionInfo().searchCount, 0);
  });

  it('should queue requests sequentially', async () => {
    const executionOrder: number[] = [];
    let callNum = 0;

    const executor: ClaudeExecutor = async (options) => {
      const n = ++callNum;
      executionOrder.push(n);
      // Small delay to verify sequencing
      await new Promise(r => setTimeout(r, 10));
      return mockResult(`Result ${n}`);
    };

    const sm = new SessionManager(baseConfig, executor);

    // Fire 3 requests simultaneously
    const results = await Promise.all([
      sm.execute('q1'),
      sm.execute('q2'),
      sm.execute('q3')
    ]);

    // Should execute in order despite being concurrent
    assert.deepStrictEqual(executionOrder, [1, 2, 3]);
    assert.strictEqual(results[0].result, 'Result 1');
    assert.strictEqual(results[1].result, 'Result 2');
    assert.strictEqual(results[2].result, 'Result 3');
  });

  it('should reset cleanly', async () => {
    const { executor } = createMockExecutor([mockResult()]);
    const sm = new SessionManager(baseConfig, executor);

    await sm.execute('query');
    assert.strictEqual(sm.getSessionInfo().searchCount, 1);

    sm.reset();
    assert.strictEqual(sm.getSessionInfo().sessionId, null);
    assert.strictEqual(sm.getSessionInfo().searchCount, 0);
  });

  it('should reject when queue is full', async () => {
    // Executor that blocks on a gate — fills the queue while first item processes
    let resolveAll: (() => void) | null = null;
    const gate = new Promise<void>(r => { resolveAll = r; });

    const slowExecutor: ClaudeExecutor = async () => {
      await gate;
      return mockResult('delayed');
    };
    const sm = new SessionManager(baseConfig, slowExecutor);

    // Item 1 gets shifted from queue and starts processing (awaiting gate).
    // Items 2-51 sit in the queue (50 items = MAX_QUEUE_SIZE).
    // Item 52 should be rejected.
    const pending = [];
    for (let i = 0; i < 51; i++) {
      pending.push(sm.execute(`query ${i}`));
    }

    // Let the event loop tick so processQueue shifts item 1
    await new Promise(r => setTimeout(r, 5));

    // Now the queue has 50 items — next one should be rejected
    await assert.rejects(
      () => sm.execute('overflow'),
      /Request queue full/
    );

    // Release the gate so all pending promises resolve cleanly
    resolveAll!();
    await Promise.all(pending);
  });
});
