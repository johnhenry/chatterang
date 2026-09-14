/**
 * MCP client lifecycle.
 *
 * Thin wrapper over `@johnhenry/mcp-query`'s `MCPClient`, doing three things
 * this app needs that the library deliberately leaves open:
 *
 * 1. Building the transport from an `McpServerConfig` — Streamable HTTP only.
 * 2. Keeping the client rebuildable, because servers are added and removed at
 *    runtime and `MCPClient` takes its server map at construction.
 * 3. Never letting a token reach anywhere it could be read back.
 *
 * The HTTP transport is imported from `@modelcontextprotocol/client` directly
 * rather than through mcp-query's `./transports` barrel. That barrel also
 * re-exports `StdioClientTransport` from the `./stdio` subpath, which pulls
 * `node:child_process` — fine in Node, fatal in a browser bundle. This app runs
 * in a webview.
 */

import { MCPClient } from '@johnhenry/mcp-query';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { McpNotSent, type McpServerConfig } from '@/domain/mcp';

export interface McpToolDescriptor {
  readonly server: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** From the server's own annotations. Absent means "unknown", not "safe". */
  readonly readOnly: boolean;
  readonly destructive: boolean;
}

export class McpConnectionError extends Error {
  constructor(
    readonly server: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

export class McpManager {
  #client: MCPClient | null = null;
  #configs: McpServerConfig[] = [];

  /**
   * Rebuild the client for a new server set.
   *
   * `MCPClient` takes its servers at construction, so changing the set means a
   * new client. The old one is closed first — leaking a live transport per edit
   * would hold sockets open for servers the user has removed.
   */
  async configure(configs: readonly McpServerConfig[]): Promise<void> {
    await this.close();
    this.#configs = configs.filter((c) => c.enabled);
    if (this.#configs.length === 0) return;

    const servers: Record<string, { transport: () => StreamableHTTPClientTransport }> = {};
    for (const config of this.#configs) {
      servers[config.name] = {
        // A factory, not an instance: mcp-query rebuilds the transport on
        // reconnect, and a spent transport cannot be reused.
        transport: () =>
          new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.token
              ? { headers: { Authorization: `Bearer ${config.token}` } }
              : undefined,
          }),
      };
    }

    this.#client = new MCPClient({
      servers: servers as never,
      clientInfo: { name: 'chatterang', version: '1' },
    });
    await this.#client.connect();
  }

  /** Every tool across every connected server, server-qualified. */
  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.#client) return [];
    const out: McpToolDescriptor[] = [];
    for (const config of this.#configs) {
      try {
        const tools = await this.#client.listTools(config.name);
        for (const tool of tools as unknown as RawTool[]) {
          out.push({
            server: config.name,
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            // Annotations are hints from the server, which is the party we are
            // least able to verify. Absent is treated as "not read-only" and
            // "possibly destructive" — the cautious reading, not the convenient
            // one.
            readOnly: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint !== false,
          });
        }
      } catch (error) {
        throw new McpConnectionError(config.name, error instanceof Error ? error.message : String(error));
      }
    }
    return out;
  }

  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // With no client nothing can have been sent, so this is a refusal and not a
    // failed call — and a failed call is recorded as one whose arguments left.
    if (!this.#client) throw new McpNotSent('No MCP client is configured.');
    return this.#client.callTool(`${server}.${name}`, args, { signal } as never);
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#configs = [];
    await client?.close().catch(() => undefined);
  }

  get configured(): boolean {
    return this.#client !== null;
  }
}

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export const mcpManager = new McpManager();
