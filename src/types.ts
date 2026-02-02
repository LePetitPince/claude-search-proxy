/**
 * TypeScript type definitions for claude-search-proxy
 */

/** Maximum request body size in bytes (1 MB) */
export const MAX_BODY_BYTES = 1_048_576;

/** Maximum query length in characters */
export const MAX_QUERY_LENGTH = 10_000;

/** Maximum queued requests before rejecting */
export const MAX_QUEUE_SIZE = 50;

/** Model name validation: alphanumeric, hyphens, dots, underscores only */
export const MODEL_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/** Localhost addresses considered safe for binding */
const LOCALHOST_ADDRS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Check whether a host string is a localhost address */
export function isLocalhostAddr(host: string): boolean {
  return LOCALHOST_ADDRS.has(host);
}

/**
 * Configuration options for the proxy server
 */
export interface ProxyConfig {
  /** Port to bind the HTTP server to */
  port: number;
  /** Host to bind the HTTP server to */
  host: string;
  /** Claude model to use for searches */
  model: string;
  /** Maximum number of searches per session before rotation */
  maxSessionSearches: number;
  /** Timeout in milliseconds for Claude CLI execution */
  timeout: number;
  /** Enable verbose debug logging */
  verbose: boolean;
}

/**
 * Claude CLI JSON output format
 */
export interface ClaudeResult {
  type: 'result' | 'error';
  subtype?: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  error?: string;
}

/**
 * OpenAI-compatible chat completion request
 */
export interface OpenAIRequest {
  model?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

/**
 * OpenAI-compatible chat completion response
 */
export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls';
  }>;
  citations?: string[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * HTTP error response
 */
export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

/**
 * Session state tracking
 */
export interface SessionState {
  sessionId: string | null;
  searchCount: number;
}

/**
 * Extracted citations from Claude result text
 */
export interface ExtractedCitations {
  cleanedText: string;
  citations: string[];
}

/**
 * Promise-based queue for sequential execution
 */
export interface QueuedTask<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}