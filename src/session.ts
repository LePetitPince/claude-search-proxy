/**
 * Session management for Claude CLI with session rotation and request queueing
 */

import { randomUUID } from 'crypto';
import type { SessionState, QueuedTask, ClaudeResult, ProxyConfig } from './types.js';
import { MAX_QUEUE_SIZE } from './types.js';
import { executeClaude } from './claude.js';

/**
 * System prompt for the search Claude instance
 */
export const SEARCH_SYSTEM_PROMPT = `You are a search engine. When given a query:
1. Use the WebSearch tool to find current, accurate information
2. Synthesize a clear, factual summary
3. Include ALL source URLs you found
4. Be concise but thorough — the consumer is another AI agent, not a human
5. Prefer recent sources over older ones
6. If the query asks for specific data (prices, dates, stats), lead with that data
7. Format: plain text synthesis, no markdown headers`;

/**
 * Function signature for Claude CLI execution (allows injection for testing)
 */
export type ClaudeExecutor = (options: {
  query: string;
  sessionId: string;
  isFirstSearch: boolean;
  systemPrompt: string;
  model: string;
  timeout: number;
  verbose: boolean;
}) => Promise<ClaudeResult>;

/**
 * SessionManager handles session rotation and sequential request queuing.
 * Accepts an optional executor for dependency injection (testing).
 */
export class SessionManager {
  private session: SessionState = {
    sessionId: null,
    searchCount: 0
  };

  private nextSession: SessionState | null = null;
  private preWarmingInProgress = false;
  private warmupComplete = false;

  private queue: Array<QueuedTask<ClaudeResult>> = [];
  private processing = false;
  private executor: ClaudeExecutor;

  constructor(private config: ProxyConfig, executor?: ClaudeExecutor) {
    this.executor = executor ?? executeClaude;
  }

  /**
   * Warm up the session by firing a lightweight search.
   * Call on server start to avoid cold-start latency on first real request.
   */
  async warmUp(): Promise<void> {
    if (this.warmupComplete) return;

    this.initializeSession();
    const sessionId = this.session.sessionId!;

    if (this.config.verbose) {
      console.error(`[Session] Warming up session ${sessionId.slice(0, 8)}...`);
    }

    try {
      await this.executor({
        query: 'ping',
        sessionId,
        isFirstSearch: true,
        systemPrompt: SEARCH_SYSTEM_PROMPT,
        model: this.config.model,
        timeout: this.config.timeout,
        verbose: this.config.verbose
      });
      this.session.searchCount++;
      this.warmupComplete = true;

      if (this.config.verbose) {
        console.error(`[Session] Warm-up complete (session ${sessionId.slice(0, 8)})`);
      }
    } catch (error) {
      console.error(`[Session] Warm-up failed:`, error instanceof Error ? error.message : error);
      // Reset so first real request creates a fresh session
      this.session = { sessionId: null, searchCount: 0 };
    }
  }

  /**
   * Execute a search query. Queues requests to ensure sequential execution.
   * Rejects immediately if the queue is full.
   */
  async execute(query: string): Promise<ClaudeResult> {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      throw new Error('Request queue full, try again later');
    }

    return new Promise<ClaudeResult>((resolve, reject) => {
      const task: QueuedTask<ClaudeResult> = {
        execute: () => this.executeSearch(query),
        resolve,
        reject
      };

      this.queue.push(task);
      this.processQueue();
    });
  }

  /**
   * Process the request queue one at a time
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift()!;

      try {
        const result = await task.execute();
        task.resolve(result);
      } catch (error) {
        task.reject(error as Error);
      }
    }

    this.processing = false;
  }

  /**
   * Execute a single search with session management
   */
  private async executeSearch(query: string): Promise<ClaudeResult> {
    // Rotate if we've hit the limit — use pre-warmed session if available
    if (this.shouldRotateSession()) {
      this.rotateSession();
    }

    // Initialize if needed
    if (!this.session.sessionId) {
      this.initializeSession();
    }

    const isFirstSearch = this.session.searchCount === 0;
    const sessionId = this.session.sessionId!;

    try {
      const result = await this.executor({
        query,
        sessionId,
        isFirstSearch,
        systemPrompt: SEARCH_SYSTEM_PROMPT,
        model: this.config.model,
        timeout: this.config.timeout,
        verbose: this.config.verbose
      });

      this.session.searchCount++;

      if (this.config.verbose) {
        console.error(`[Session] Search ${this.session.searchCount}/${this.config.maxSessionSearches} (session ${sessionId.slice(0, 8)}...)`);
      }

      // Pre-warm next session when approaching the limit
      this.maybePreWarmNextSession();

      return result;
    } catch (error) {
      if (this.config.verbose) {
        console.error(`[Session] Search failed:`, error);
      }
      throw error;
    }
  }

  /**
   * Pre-warm the next session when we're 2 searches from the rotation limit.
   * Runs in the background — doesn't block the current request.
   */
  private maybePreWarmNextSession(): void {
    const remaining = this.config.maxSessionSearches - this.session.searchCount;
    if (remaining > 2 || this.preWarmingInProgress || this.nextSession) return;

    this.preWarmingInProgress = true;
    const newSessionId = randomUUID();

    if (this.config.verbose) {
      console.error(`[Session] Pre-warming next session ${newSessionId.slice(0, 8)}...`);
    }

    this.executor({
      query: 'ping',
      sessionId: newSessionId,
      isFirstSearch: true,
      systemPrompt: SEARCH_SYSTEM_PROMPT,
      model: this.config.model,
      timeout: this.config.timeout,
      verbose: this.config.verbose
    }).then(() => {
      this.nextSession = { sessionId: newSessionId, searchCount: 1 };
      this.preWarmingInProgress = false;

      if (this.config.verbose) {
        console.error(`[Session] Next session pre-warmed: ${newSessionId.slice(0, 8)}`);
      }
    }).catch(error => {
      this.preWarmingInProgress = false;
      console.error(`[Session] Pre-warm failed:`, error instanceof Error ? error.message : error);
    });
  }

  private shouldRotateSession(): boolean {
    return this.session.searchCount >= this.config.maxSessionSearches;
  }

  private initializeSession(): void {
    this.session = {
      sessionId: randomUUID(),
      searchCount: 0
    };

    if (this.config.verbose) {
      console.error(`[Session] New session: ${this.session.sessionId}`);
    }
  }

  private rotateSession(): void {
    const oldId = this.session.sessionId;

    if (this.nextSession) {
      // Use pre-warmed session
      this.session = this.nextSession;
      this.nextSession = null;

      if (this.config.verbose) {
        console.error(`[Session] Rotated (pre-warmed): ${oldId?.slice(0, 8)} → ${this.session.sessionId?.slice(0, 8)}`);
      }
    } else {
      // No pre-warmed session available — cold rotate
      this.initializeSession();

      if (this.config.verbose) {
        console.error(`[Session] Rotated (cold): ${oldId?.slice(0, 8)} → ${this.session.sessionId?.slice(0, 8)}`);
      }
    }
  }

  /** Get current session info (for health endpoint / debugging) */
  getSessionInfo(): { sessionId: string | null; searchCount: number; maxSearches: number } {
    return {
      sessionId: this.session.sessionId,
      searchCount: this.session.searchCount,
      maxSearches: this.config.maxSessionSearches
    };
  }

  /** Reset session state (for testing) */
  reset(): void {
    this.session = { sessionId: null, searchCount: 0 };
    this.nextSession = null;
    this.preWarmingInProgress = false;
    this.warmupComplete = false;
    this.queue = [];
    this.processing = false;
  }
}
