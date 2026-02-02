/**
 * HTTP server implementation using Node.js built-in http module.
 * Zero external dependencies.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import type { ProxyConfig, OpenAIRequest, ErrorResponse } from './types.js';
import { MAX_BODY_BYTES, MAX_QUERY_LENGTH } from './types.js';

/** Check if an Origin header is a localhost address (any port) */
function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/** Check if a Host header is a localhost address (DNS rebinding protection) */
function isLocalHost(host: string | undefined): boolean {
  if (!host) return true; // No Host header = direct connection, allow
  const hostname = host.split(':')[0]; // Strip port
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
import { SessionManager, type ClaudeExecutor } from './session.js';
import { formatOpenAIResponse, extractQuery, formatErrorResponse } from './format.js';

/**
 * HTTP server for the Claude search proxy.
 * Optionally accepts a ClaudeExecutor for dependency injection (testing).
 */
export class ProxyServer {
  private sessionManager: SessionManager;

  constructor(private config: ProxyConfig, executor?: ClaudeExecutor) {
    this.sessionManager = new SessionManager(config, executor);
  }

  /**
   * Start the HTTP server. Returns the underlying Server for lifecycle control.
   */
  async start(): Promise<Server> {
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch(error => {
        console.error('[Server] Unhandled error:', error);
        this.sendError(res, 'Internal server error', 500);
      });
    });

    return new Promise<Server>((resolve, reject) => {
      server.listen(this.config.port, this.config.host, () => {
        if (this.config.verbose) {
          console.error(`[Server] Listening on ${this.config.host}:${this.config.port}`);
        }
        resolve(server);
      });

      server.on('error', (error: any) => {
        if (error.code === 'EADDRINUSE') {
          console.error('');
          console.error(`  ✗ Port ${this.config.port} is already in use`);
          console.error(`  Try: claude-search-proxy --port ${this.config.port + 1}`);
          console.error('');
          process.exit(1);
        } else {
          reject(error);
        }
      });

      // Graceful shutdown
      const shutdown = () => {
        console.error('[Server] Shutting down...');
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  }

  /** Route incoming requests */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { method, url } = req;

    // DNS rebinding protection: reject requests with non-localhost Host headers
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden: non-localhost Host header', type: 'forbidden' } }));
      return;
    }

    this.setCors(req, res);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (this.config.verbose) {
      console.error(`[Server] ${method} ${url}`);
    }

    try {
      if (method === 'GET' && url === '/health') {
        this.handleHealth(res);
      } else if (method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
        await this.handleSearch(req, res);
      } else {
        this.sendError(res, 'Not found', 404);
      }
    } catch (error) {
      console.error('[Server] Request error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      const status = message.includes('queue full') ? 503 : 500;
      this.sendError(res, message, status);
    }
  }

  /** GET /health */
  private handleHealth(res: ServerResponse): void {
    const body = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      session: this.sessionManager.getSessionInfo(),
      config: {
        model: this.config.model,
        maxSessionSearches: this.config.maxSessionSearches,
        timeout: this.config.timeout
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  /** POST /v1/chat/completions (and /chat/completions) */
  private async handleSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse body (with size limit)
    let body: unknown;
    try {
      body = await this.readJson(req);
    } catch (err) {
      const msg = err instanceof Error && err.message === 'Request body too large'
        ? 'Request body too large' : 'Invalid JSON body';
      const code = msg === 'Request body too large' ? 413 : 400;
      this.sendError(res, msg, code);
      return;
    }
    const request = body as OpenAIRequest;

    // Validate messages
    if (!request.messages || !Array.isArray(request.messages)) {
      this.sendError(res, 'Missing or invalid messages array', 400);
      return;
    }

    const query = extractQuery(request.messages);

    // Validate query length
    if (query.length > MAX_QUERY_LENGTH) {
      this.sendError(res, `Query too long (max ${MAX_QUERY_LENGTH} characters)`, 400);
      return;
    }

    if (this.config.verbose) {
      console.error(`[Server] Query: ${query.slice(0, 100)}${query.length > 100 ? '...' : ''}`);
    }

    // Execute search
    const claudeResult = await this.sessionManager.execute(query);

    // Format response
    const response = formatOpenAIResponse(claudeResult, this.config.model);

    if (this.config.verbose) {
      console.error(`[Server] Done. Citations: ${response.citations?.length ?? 0}`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /** Parse JSON body from request stream, enforcing MAX_BODY_BYTES */
  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });

      req.on('error', reject);
    });
  }

  /** Set CORS headers — reflects origin if it's a localhost address */
  private setCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && isLocalOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  private sendError(res: ServerResponse, message: string, status = 500): void {
    const body: ErrorResponse = formatErrorResponse(message);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
