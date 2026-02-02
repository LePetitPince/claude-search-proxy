/**
 * Claude CLI execution layer with proper stdin handling and error management
 */

import { spawn, type ChildProcess } from 'child_process';
import type { ClaudeResult } from './types.js';

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
 * Execute Claude CLI with proper stdin handling and error management
 * CRITICAL: stdin must be piped and closed, or the process hangs forever
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

  // Build Claude CLI arguments
  const args = buildClaudeArgs({
    sessionId,
    isFirstSearch,
    systemPrompt,
    model
  });

  if (verbose) {
    console.error(`[Claude] Executing: claude ${args.join(' ')}`);
    console.error(`[Claude] Query: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`);
  }

  return new Promise<ClaudeResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timeoutHandle: NodeJS.Timeout;

    // Spawn Claude process
    const child: ChildProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Set up timeout
    timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude CLI timeout after ${timeout}ms`));
    }, timeout);

    // Handle stdout
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    // Handle stderr
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (verbose) {
        console.error(`[Claude stderr] ${data.toString().trim()}`);
      }
    });

    // Handle process exit
    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timeoutHandle);

      if (verbose) {
        console.error(`[Claude] Process exited with code ${code}, signal ${signal}`);
      }

      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}. stderr: ${stderr}`));
        return;
      }

      if (signal) {
        reject(new Error(`Claude CLI killed by signal ${signal}`));
        return;
      }

      // Parse JSON output
      try {
        const result = parseClaudeOutput(stdout);
        
        if (result.is_error) {
          reject(new Error(`Claude returned error: ${result.error || result.result}`));
          return;
        }

        resolve(result);
      } catch (error) {
        reject(new Error(`Failed to parse Claude output: ${error}. Raw output: ${stdout.substring(0, 500)}`));
      }
    });

    // Handle spawn errors
    child.on('error', (error: Error) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to spawn Claude CLI: ${error.message}`));
    });

    // CRITICAL: Write query to stdin and close it
    // If stdin remains open/attached to terminal, the process hangs forever
    if (child.stdin) {
      child.stdin.write(query);
      child.stdin.end(); // Must close stdin!
    } else {
      clearTimeout(timeoutHandle);
      child.kill();
      reject(new Error('Failed to access Claude CLI stdin'));
    }
  });
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
    '-p',  // Prompt mode (non-interactive)
    '--output-format', 'json',
    '--allowedTools', 'WebSearch',
    '--model', model
    // NOTE: Do NOT use --no-session-persistence — it prevents --resume from working.
    // Sessions persist to ~/.claude/ which is needed for prompt caching.
  ];

  if (isFirstSearch) {
    // First search: establish session with system prompt
    args.push('--session-id', sessionId);
    args.push('--append-system-prompt', systemPrompt);
  } else {
    // Subsequent searches: resume existing session (prompt cached)
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
    
    // Validate required fields
    if (typeof parsed.type !== 'string') {
      throw new Error('Missing or invalid "type" field');
    }
    
    if (typeof parsed.is_error !== 'boolean') {
      throw new Error('Missing or invalid "is_error" field');
    }
    
    if (typeof parsed.result !== 'string') {
      throw new Error('Missing or invalid "result" field');
    }

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

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}