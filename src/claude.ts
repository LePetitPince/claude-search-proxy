/**
 * Claude CLI execution layer with proper stdin handling and error management
 */

import { spawn, type ChildProcess } from 'child_process';
import type { ClaudeResult } from './types.js';
import { MODEL_NAME_RE } from './types.js';

/** Grace period before escalating SIGTERM → SIGKILL (ms) */
const KILL_GRACE_MS = 5_000;

/**
 * Options for executing Claude CLI
 */
interface ClaudeExecutionOptions {
  query: string;
  sessionId: string;
  isFirstSearch: boolean;
  systemPrompt: string;
  model: string;
  timeout: number;
  verbose: boolean;
}

/**
 * Execute Claude CLI with proper stdin handling and error management.
 * CRITICAL: stdin must be piped and closed, or the process hangs forever.
 */
export async function executeClaude(options: ClaudeExecutionOptions): Promise<ClaudeResult> {
  const {
    query,
    sessionId,
    isFirstSearch,
    systemPrompt,
    model,
    timeout,
    verbose
  } = options;

  // Validate model name to prevent flag injection
  if (!MODEL_NAME_RE.test(model)) {
    throw new Error('Invalid model name: must contain only alphanumeric characters, hyphens, dots, and underscores');
  }

  const args = buildClaudeArgs({ sessionId, isFirstSearch, systemPrompt, model });

  if (verbose) {
    console.error(`[Claude] Executing: claude ${args.join(' ')}`);
    console.error(`[Claude] Query: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`);
  }

  return new Promise<ClaudeResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn(); }
    };

    const child: ChildProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Timeout with SIGTERM → SIGKILL escalation
    const timeoutHandle = setTimeout(() => {
      killGracefully(child);
      settle(() => reject(new Error(`Claude CLI timeout after ${timeout}ms`)));
    }, timeout);

    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (verbose) console.error(`[Claude stderr] ${data.toString().trim()}`);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timeoutHandle);

      if (verbose) {
        console.error(`[Claude] Exited code=${code} signal=${signal}`);
      }

      if (code !== 0 && code !== null) {
        // Log full details server-side, return sanitised message
        console.error(`[Claude] CLI error (code ${code}): ${stderr.slice(0, 500)}`);
        settle(() => reject(new Error('Claude CLI returned an error')));
        return;
      }

      if (signal) {
        settle(() => reject(new Error('Claude CLI was terminated')));
        return;
      }

      try {
        const result = parseClaudeOutput(stdout);
        if (result.is_error) {
          console.error(`[Claude] Returned error: ${result.error ?? result.result}`);
          settle(() => reject(new Error('Claude search failed')));
          return;
        }
        settle(() => resolve(result));
      } catch (error) {
        console.error(`[Claude] Parse failure: ${error}. Raw (500 chars): ${stdout.substring(0, 500)}`);
        settle(() => reject(new Error('Failed to parse Claude response')));
      }
    });

    child.on('error', (error: Error) => {
      clearTimeout(timeoutHandle);
      console.error(`[Claude] Spawn error: ${error.message}`);
      settle(() => reject(new Error('Failed to start Claude CLI')));
    });

    // CRITICAL: Write query to stdin and close it
    if (child.stdin) {
      child.stdin.write(query);
      child.stdin.end();
    } else {
      clearTimeout(timeoutHandle);
      child.kill();
      settle(() => reject(new Error('Failed to access Claude CLI stdin')));
    }
  });
}

/**
 * Kill a child process gracefully: SIGTERM first, SIGKILL after grace period.
 */
function killGracefully(child: ChildProcess): void {
  child.kill('SIGTERM');
  const forceKill = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }, KILL_GRACE_MS);
  child.on('exit', () => clearTimeout(forceKill));
}

/**
 * Build Claude CLI arguments based on session state
 */
function buildClaudeArgs(options: {
  sessionId: string;
  isFirstSearch: boolean;
  systemPrompt: string;
  model: string;
}): string[] {
  const { sessionId, isFirstSearch, systemPrompt, model } = options;

  const args = [
    '-p',
    '--output-format', 'json',
    '--allowedTools', 'WebSearch',
    '--model', model
  ];

  if (isFirstSearch) {
    args.push('--session-id', sessionId);
    args.push('--append-system-prompt', systemPrompt);
  } else {
    args.push('--resume', sessionId);
  }

  return args;
}

/**
 * Parse Claude CLI JSON output
 */
function parseClaudeOutput(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();

  if (!trimmed) {
    throw new Error('Empty output from Claude CLI');
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (typeof parsed.type !== 'string') throw new Error('Missing "type" field');
    if (typeof parsed.is_error !== 'boolean') throw new Error('Missing "is_error" field');
    if (typeof parsed.result !== 'string') throw new Error('Missing "result" field');

    return parsed as ClaudeResult;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Check if Claude CLI is available in PATH
 */
export async function checkClaudeAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('which', ['claude'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
