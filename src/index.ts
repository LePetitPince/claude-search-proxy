#!/usr/bin/env node

/**
 * claude-search-proxy - Entry point and CLI argument parsing
 * Zero external dependencies - using process.argv manually
 */

import type { ProxyConfig } from './types.js';
import { MODEL_NAME_RE, isLocalhostAddr } from './types.js';
import { ProxyServer } from './server.js';
import { checkClaudeAvailable } from './claude.js';

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ProxyConfig = {
  port: 52480,
  host: '127.0.0.1',
  model: 'claude-sonnet-4-20250514',
  maxSessionSearches: 20,
  timeout: 60000,
  verbose: false
};

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
claude-search-proxy - OpenAI-compatible HTTP proxy for Claude CLI WebSearch

USAGE:
  claude-search-proxy [OPTIONS]

OPTIONS:
  --port <number>              Port to bind server to (default: ${DEFAULT_CONFIG.port})
  --host <string>              Host to bind server to (default: ${DEFAULT_CONFIG.host})
  --model <string>             Claude model to use (default: ${DEFAULT_CONFIG.model})
  --max-session-searches <n>   Max searches per session before rotation (default: ${DEFAULT_CONFIG.maxSessionSearches})
  --timeout <ms>               Claude CLI timeout in milliseconds (default: ${DEFAULT_CONFIG.timeout})
  --verbose                    Enable verbose debug logging
  --help                       Show this help message

EXAMPLES:
  claude-search-proxy
  claude-search-proxy --port 3271 --verbose
  claude-search-proxy --model claude-haiku-4 --max-session-searches 10

ENDPOINTS:
  POST /v1/chat/completions    OpenAI-compatible search endpoint
  POST /chat/completions       Same as above (without /v1 prefix)
  GET  /health                 Health check and status

OPENAI CLIENT CONFIGURATION:
  {
    "baseURL": "http://localhost:${DEFAULT_CONFIG.port}",
    "apiKey": "not-needed"
  }
`);
}

/**
 * Parse command line arguments manually
 */
function parseArguments(): ProxyConfig {
  const config = { ...DEFAULT_CONFIG };
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;

      case '--port':
        const port = parseInt(args[++i]);
        if (isNaN(port) || port <= 0 || port > 65535) {
          console.error('Error: --port must be a valid port number (1-65535)');
          process.exit(1);
        }
        config.port = port;
        break;

      case '--host':
        const host = args[++i];
        if (!host) {
          console.error('Error: --host requires a value');
          process.exit(1);
        }
        config.host = host;
        break;

      case '--model':
        const model = args[++i];
        if (!model) {
          console.error('Error: --model requires a value');
          process.exit(1);
        }
        if (!MODEL_NAME_RE.test(model)) {
          console.error('Error: --model must contain only alphanumeric characters, hyphens, dots, and underscores');
          process.exit(1);
        }
        config.model = model;
        break;

      case '--max-session-searches':
        const maxSearches = parseInt(args[++i]);
        if (isNaN(maxSearches) || maxSearches <= 0) {
          console.error('Error: --max-session-searches must be a positive number');
          process.exit(1);
        }
        config.maxSessionSearches = maxSearches;
        break;

      case '--timeout':
        const timeout = parseInt(args[++i]);
        if (isNaN(timeout) || timeout <= 0) {
          console.error('Error: --timeout must be a positive number (milliseconds)');
          process.exit(1);
        }
        config.timeout = timeout;
        break;

      case '--verbose':
        config.verbose = true;
        break;

      default:
        console.error(`Error: Unknown argument: ${arg}`);
        console.error('Use --help for usage information');
        process.exit(1);
    }
  }

  return config;
}

/**
 * Validate environment and dependencies
 */
async function validateEnvironment(): Promise<void> {
  // Check if Claude CLI is available
  const claudeAvailable = await checkClaudeAvailable();
  if (!claudeAvailable) {
    console.error('Error: Claude CLI not found in PATH');
    console.error('Please install Claude CLI: https://claude.ai/cli');
    process.exit(1);
  }

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (majorVersion < 18) {
    console.error(`Error: Node.js >= 18 required, got ${nodeVersion}`);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Parse arguments
    const config = parseArguments();

    if (config.verbose) {
      console.error('[Main] Configuration:', JSON.stringify(config, null, 2));
    }

    // Warn on non-localhost bind
    if (!isLocalhostAddr(config.host)) {
      console.error(`⚠️  Warning: Binding to ${config.host} exposes the proxy to the network.`);
      console.error('   This proxy has no authentication. Use 127.0.0.1 (default) for local use.');
    }

    // Validate environment
    await validateEnvironment();

    if (config.verbose) {
      console.error('[Main] Environment validation passed');
    }

    // Create and start server
    const server = new ProxyServer(config);
    await server.start();

    console.error('[Main] Server started successfully');

  } catch (error) {
    console.error('[Main] Startup failed:', error);
    process.exit(1);
  }
}

/**
 * Handle unhandled errors
 */
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error);
  process.exit(1);
});

// Start the application
main().catch((error) => {
  console.error('[Main] Fatal error:', error);
  process.exit(1);
});