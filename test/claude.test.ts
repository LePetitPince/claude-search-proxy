/**
 * Tests for Claude CLI execution layer.
 * Tests buildClaudeArgs logic and output parsing via the public API.
 * Mocking spawn properly requires running a fake "claude" script.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, unlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { executeClaude, checkClaudeAvailable } from '../src/claude.js';
import type { ClaudeResult } from '../src/types.js';

/**
 * Create a fake "claude" script that echoes back its arguments as JSON.
 * This lets us test the real spawn + stdin pipe + JSON parse pipeline
 * without calling the actual Claude CLI.
 */
function createFakeClaude(dir: string, behavior: 'success' | 'error-exit' | 'bad-json' | 'error-result' | 'slow'): string {
  const scriptPath = join(dir, 'claude');

  let script: string;
  switch (behavior) {
    case 'success':
      script = [
        '#!/bin/bash',
        'cat > /dev/null',  // consume stdin
        'echo \'{"type":"result","subtype":"success","is_error":false,"duration_ms":1000,"result":"Search result for query","session_id":"fake-session","total_cost_usd":0.01,"usage":{"input_tokens":50,"output_tokens":100,"total_tokens":150}}\''
      ].join('\n');
      break;

    case 'error-exit':
      script = `#!/bin/bash
echo "Authentication failed" >&2
exit 1`;
      break;

    case 'bad-json':
      script = [
        '#!/bin/bash',
        'cat > /dev/null',
        'echo \'not valid json {\''
      ].join('\n');
      break;

    case 'error-result':
      script = [
        '#!/bin/bash',
        'cat > /dev/null',  // consume stdin without echoing
        'echo \'{"type":"result","is_error":true,"duration_ms":500,"result":"Rate limited","session_id":"err","total_cost_usd":0,"error":"Rate limited"}\''
      ].join('\n');
      break;

    case 'slow':
      script = `#!/bin/bash
sleep 5
echo '{"type":"result","is_error":false,"duration_ms":5000,"result":"slow","session_id":"s","total_cost_usd":0}'`;
      break;
  }

  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe('executeClaude (with fake CLI)', () => {
  let tmpDir: string;
  let origPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `claude-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    origPath = process.env.PATH ?? '';
    // Prepend our temp dir so our fake "claude" is found first
    process.env.PATH = `${tmpDir}:${origPath}`;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    try { unlinkSync(join(tmpDir, 'claude')); } catch { /* ignore */ }
  });

  it('should execute successfully and parse JSON output', async () => {
    createFakeClaude(tmpDir, 'success');

    const result = await executeClaude({
      query: 'test query',
      sessionId: 'test-session-123',
      isFirstSearch: true,
      systemPrompt: 'You are a search engine',
      model: 'claude-sonnet-4',
      timeout: 10000,
      verbose: false
    });

    assert.strictEqual(result.type, 'result');
    assert.strictEqual(result.is_error, false);
    assert.ok(typeof result.result === 'string');
    assert.ok(result.result.length > 0);
  });

  it('should reject on non-zero exit code', async () => {
    createFakeClaude(tmpDir, 'error-exit');

    await assert.rejects(
      () => executeClaude({
        query: 'test',
        sessionId: 'test',
        isFirstSearch: true,
        systemPrompt: 'test',
        model: 'claude-sonnet-4',
        timeout: 10000,
        verbose: false
      }),
      /Claude CLI returned an error/
    );
  });

  it('should reject on malformed JSON', async () => {
    createFakeClaude(tmpDir, 'bad-json');

    await assert.rejects(
      () => executeClaude({
        query: 'test',
        sessionId: 'test',
        isFirstSearch: true,
        systemPrompt: 'test',
        model: 'claude-sonnet-4',
        timeout: 10000,
        verbose: false
      }),
      /Failed to parse Claude response/
    );
  });

  it('should reject on Claude error result (is_error=true)', async () => {
    createFakeClaude(tmpDir, 'error-result');

    await assert.rejects(
      () => executeClaude({
        query: 'test',
        sessionId: 'test',
        isFirstSearch: true,
        systemPrompt: 'test',
        model: 'claude-sonnet-4',
        timeout: 10000,
        verbose: false
      }),
      /Claude search failed/
    );
  });

  it('should reject on timeout', async () => {
    createFakeClaude(tmpDir, 'slow');

    await assert.rejects(
      () => executeClaude({
        query: 'test',
        sessionId: 'test',
        isFirstSearch: true,
        systemPrompt: 'test',
        model: 'claude-sonnet-4',
        timeout: 200, // Very short timeout
        verbose: false
      }),
      /Claude CLI timeout/
    );
  });
});

describe('model validation', () => {
  it('should reject model names with spaces (flag injection)', async () => {
    await assert.rejects(
      () => executeClaude({
        query: 'test',
        sessionId: 'test',
        isFirstSearch: true,
        systemPrompt: 'test',
        model: 'sonnet --session-id /tmp/evil',
        timeout: 10000,
        verbose: false
      }),
      /Invalid model name/
    );
  });

  it('should reject model names with special characters', async () => {
    await assert.rejects(
      () => executeClaude({
        query: 'test',
        sessionId: 'test',
        isFirstSearch: true,
        systemPrompt: 'test',
        model: 'model;rm -rf /',
        timeout: 10000,
        verbose: false
      }),
      /Invalid model name/
    );
  });

  it('should accept valid model names', async () => {
    // This will fail because there's no real claude, but it should get past validation
    // The error should NOT be about model name
    const tmpDir2 = join(tmpdir(), `claude-model-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir2, { recursive: true });
    const origPath = process.env.PATH ?? '';
    
    // Create a success fake claude
    const scriptPath = join(tmpDir2, 'claude');
    writeFileSync(scriptPath, [
      '#!/bin/bash',
      'cat > /dev/null',
      'echo \'{"type":"result","is_error":false,"duration_ms":1,"result":"ok","session_id":"s","total_cost_usd":0}\'',
    ].join('\n'), { mode: 0o755 });
    
    process.env.PATH = `${tmpDir2}:${origPath}`;
    try {
      const result = await executeClaude({
        query: 'test',
        sessionId: 'test',
        isFirstSearch: true,
        systemPrompt: 'test',
        model: 'claude-sonnet-4-20250514',
        timeout: 10000,
        verbose: false
      });
      assert.strictEqual(result.is_error, false);
    } finally {
      process.env.PATH = origPath;
      try { unlinkSync(scriptPath); } catch { /* */ }
    }
  });
});

describe('checkClaudeAvailable', () => {
  it('should return true when claude exists in PATH', async () => {
    // Create a fake claude in a temp dir
    const tmpDir2 = join(tmpdir(), `claude-avail-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir2, { recursive: true });
    const scriptPath = join(tmpDir2, 'claude');
    writeFileSync(scriptPath, '#!/bin/bash\necho ok', { mode: 0o755 });
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${tmpDir2}:${origPath}`;
    try {
      const available = await checkClaudeAvailable();
      assert.strictEqual(available, true);
    } finally {
      process.env.PATH = origPath;
      try { unlinkSync(scriptPath); } catch { /* */ }
    }
  });

  it('should return false when claude is not in PATH', async () => {
    // Use an empty temp dir as sole PATH entry — guarantees no claude
    const emptyDir = join(tmpdir(), `empty-path-${randomUUID().slice(0, 8)}`);
    mkdirSync(emptyDir, { recursive: true });
    const origPath = process.env.PATH ?? '';
    process.env.PATH = emptyDir;
    try {
      const available = await checkClaudeAvailable();
      assert.strictEqual(available, false);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
