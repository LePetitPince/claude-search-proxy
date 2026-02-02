/**
 * OpenClaw extension for claude-search-proxy.
 *
 * Registers a managed service that spawns the proxy as a child process
 * when the gateway starts, and kills it on shutdown. Also provides a
 * CLI setup command that patches the OpenClaw search config.
 *
 * Install:
 *   openclaw plugins install claude-search-proxy
 *   # or load from path:
 *   # plugins.load.paths: ["~/path/to/claude-search-proxy/extension"]
 *
 * Enable:
 *   openclaw plugins enable claude-search-proxy
 *
 * The extension expects `claude-search-proxy` (the npm bin) to be
 * available in PATH — either via global install or npx.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const DEFAULT_PORT = 52_480;
const DEFAULT_HOST = "127.0.0.1";
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const STARTUP_TIMEOUT_MS = 10_000;

/** Resolve the proxy binary — prefer global install, fall back to npx */
function resolveCommand(): { cmd: string; args: string[] } {
  return { cmd: "claude-search-proxy", args: [] };
}

/** Wait for the proxy health endpoint to respond */
async function waitForHealth(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/health`);
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const plugin = {
  id: "claude-search-proxy",
  name: "Claude Search Proxy",
  description:
    "Managed claude-search-proxy service — zero-cost web search via any Claude subscription's WebSearch",

  configSchema: emptyPluginConfigSchema(),

  register(api: any) {
    let child: ChildProcess | null = null;
    let healthTimer: ReturnType<typeof setInterval> | null = null;

    const port = DEFAULT_PORT;
    const host = DEFAULT_HOST;

    // ── Managed service ──────────────────────────────────────────────
    api.registerService({
      id: "claude-search-proxy",

      async start(ctx: any) {
        // Check if search config points at us
        const searchCfg = ctx.config?.tools?.web?.search;
        const perplexityCfg = searchCfg?.perplexity;
        const isConfigured =
          searchCfg?.provider === "perplexity" &&
          perplexityCfg?.baseUrl?.includes(String(port));

        if (!isConfigured) {
          ctx.logger.warn(
            `claude-search-proxy: search config not detected. Add this to your openclaw.json:\n` +
            `  "tools": { "web": { "search": {\n` +
            `    "provider": "perplexity",\n` +
            `    "perplexity": { "baseUrl": "http://localhost:${port}", "apiKey": "not-needed" }\n` +
            `  }}}`,
          );
        }

        const { cmd, args } = resolveCommand();
        const fullArgs = [...args, "--port", String(port), "--host", host];

        ctx.logger.info(
          `claude-search-proxy: starting ${cmd} ${fullArgs.join(" ")}`,
        );

        child = spawn(cmd, fullArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
          detached: false,
        });

        // Pipe output to logger
        child.stdout?.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          if (line) ctx.logger.info(`[proxy] ${line}`);
        });

        child.stderr?.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          if (line) ctx.logger.info(`[proxy] ${line}`);
        });

        child.on("error", (err) => {
          ctx.logger.error(
            `claude-search-proxy: spawn error: ${err.message}`,
          );
          child = null;
        });

        child.on("exit", (code, signal) => {
          if (code !== null && code !== 0) {
            ctx.logger.warn(
              `claude-search-proxy: exited with code ${code}`,
            );
          } else if (signal) {
            ctx.logger.info(
              `claude-search-proxy: killed by signal ${signal}`,
            );
          }
          child = null;
        });

        // Wait for health
        const healthy = await waitForHealth(host, port, STARTUP_TIMEOUT_MS);
        if (healthy) {
          ctx.logger.info(
            `claude-search-proxy: ready at http://${host}:${port}`,
          );
        } else {
          ctx.logger.warn(
            `claude-search-proxy: started but health check timed out after ${STARTUP_TIMEOUT_MS}ms`,
          );
        }

        // Periodic health monitoring
        healthTimer = setInterval(async () => {
          if (!child) return;
          try {
            const res = await fetch(`http://${host}:${port}/health`);
            if (!res.ok) {
              ctx.logger.warn(
                `claude-search-proxy: health check returned ${res.status}`,
              );
            }
          } catch {
            ctx.logger.warn(
              "claude-search-proxy: health check failed (proxy may have crashed)",
            );
          }
        }, HEALTH_CHECK_INTERVAL_MS);
      },

      async stop(ctx: any) {
        if (healthTimer) {
          clearInterval(healthTimer);
          healthTimer = null;
        }

        if (!child) return;

        ctx.logger.info("claude-search-proxy: stopping...");

        // Graceful shutdown via SIGTERM, then SIGKILL after timeout
        return new Promise<void>((resolve) => {
          const kill = setTimeout(() => {
            if (child) {
              ctx.logger.warn(
                "claude-search-proxy: SIGTERM timeout, sending SIGKILL",
              );
              child.kill("SIGKILL");
            }
            resolve();
          }, 5_000);

          child!.once("exit", () => {
            clearTimeout(kill);
            child = null;
            ctx.logger.info("claude-search-proxy: stopped");
            resolve();
          });

          child!.kill("SIGTERM");
        });
      },
    });
  },
};

export default plugin;
