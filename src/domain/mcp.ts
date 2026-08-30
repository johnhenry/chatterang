/**
 * Remote MCP servers.
 *
 * The whole point of this app is that inference happens on the device. An MCP
 * tool is the one thing here that deliberately breaks that: calling it sends
 * arguments — which the model derived from the conversation — to someone else's
 * server over the network.
 *
 * That is a legitimate thing to want, and it is also the sharpest edge in the
 * product. So the domain model carries the destination everywhere it goes, and
 * nothing about an MCP tool is allowed to look like a local one.
 *
 * Remote-only, over Streamable HTTP. There is no stdio transport here and there
 * should not be: stdio means spawning a local process, which a browser cannot
 * do and a mobile webview should not.
 */

export interface McpServerConfig {
  readonly id: string;
  /** Short handle used to namespace tool names: `github.create_issue`. */
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  /** Sent as `Authorization`. Never rendered, never mounted into the shell VFS. */
  readonly token?: string;
  readonly createdAt: number;
}

export type McpServerStatus = 'idle' | 'connecting' | 'ready' | 'error';

export interface McpServerState {
  readonly id: string;
  readonly status: McpServerStatus;
  readonly toolCount: number;
  readonly error?: string;
}

/** `https:` only, and never a credential in the URL. */
export function validateServerUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { ok: false, reason: 'Only https: is allowed, or localhost for development.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Put credentials in the token field, not the URL.' };
  }
  return { ok: true, url: parsed.toString() };
}

/** The host a tool call would reach, for display. Never the full URL — a path can be long and is not the point. */
export function destinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

/** Server-qualified tool id, so two servers can both expose `search`. */
export function qualifiedToolName(serverName: string, toolName: string): string {
  return `${serverName}.${toolName}`;
}
