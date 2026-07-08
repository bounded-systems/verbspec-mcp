// @bounded-systems/verbspec-mcp — turn a verbspec verb Registry into an MCP server.
//
// verbspec authors each check/generator ONCE as a typed VerbSpec (Zod input/output + summary +
// actor) and projects it to CLI / Anthropic / OpenAPI / OpenRPC surfaces. It also projects MCP
// *tool descriptors* (`toMcpTool`), but it deliberately ships no server — the MCP wire protocol,
// the transport, and result-wrapping live here, on top of the official SDK. Hand it a `Registry`
// and get a real MCP server: every verb becomes a tool whose input/output schemas ARE the verb's
// own Zod schemas (zero drift), and whose handler runs the verb.
//
//   import { serveStdio } from "@bounded-systems/verbspec-mcp";
//   import { registry } from "./registry";
//   await serveStdio(registry, { name: "spd", version: "0.1.0" });
//
// Why the SDK (not a hand-rolled JSON-RPC loop): spec compliance, stdio + Streamable HTTP
// transports, and structured-content handling for free. `buildMcpServer` returns the configured
// `McpServer` so a caller can attach any transport (e.g. HTTP); `serveStdio` is the stdio one-liner.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  verbToken,
  render,
  toOutputJsonSchema,
  type Registry,
  type AnyVerbSpec,
} from "@bounded-systems/verbspec";

/** Shared options for building/serving a verbspec MCP server. */
export interface McpServerOptions {
  /** Server name advertised in the MCP `initialize` handshake. Default `"verbspec-mcp"`. */
  name?: string;
  /** Server version advertised in the handshake. Default `"0.0.0"`. */
  version?: string;
  /**
   * Restrict which verbs are exposed as tools (e.g. read-only surfaces, or an actor allowlist).
   * Default: every verb in the registry.
   */
  filter?: (verb: AnyVerbSpec) => boolean;
}

/** A verb's output schema is object-shaped iff its JSON-Schema projection has `type: "object"`. */
const isObjectSchema = (js: unknown): boolean =>
  typeof js === "object" && js !== null && (js as { type?: unknown }).type === "object";

/**
 * Register one verb as an MCP tool. The verb's own Zod `input`/`output` are handed straight to the
 * SDK (its `inputSchema`/`outputSchema` accept any Zod schema), so the tool's contract can't drift
 * from the verb. `outputSchema` + `structuredContent` are wired only when the output is object-
 * shaped (MCP structured content must be a JSON object; a non-object output degrades to text-only).
 */
function registerVerb(server: McpServer, v: AnyVerbSpec): void {
  const outputIsObject = isObjectSchema(toOutputJsonSchema(v));
  server.registerTool(
    verbToken(v.id),
    {
      title: v.id,
      description: v.summary,
      // The SDK validates incoming arguments against this schema before calling the handler.
      inputSchema: v.input,
      // `undefined` when non-object: the SDK skips advertising + output-validation entirely.
      outputSchema: outputIsObject ? v.output : undefined,
    },
    // `args` arrives already validated/coerced against `v.input` by the SDK. Errors thrown here —
    // and output-schema validation failures — are caught by the SDK and returned as an `isError`
    // tool result (not a transport crash), so a verb that throws surfaces its message to the model.
    async (args: unknown) => {
      const out = await v.run(args, v.deps?.());
      const text = render(out); // canonical JSON view — the verb's CLI `render` is CLI-only.
      return outputIsObject
        ? { content: [{ type: "text" as const, text }], structuredContent: out as Record<string, unknown> }
        : { content: [{ type: "text" as const, text }] };
    },
  );
}

/**
 * Build an MCP server exposing every verb in `registry` as a tool. Returns the configured
 * {@link McpServer} without connecting a transport — attach one yourself (e.g. a Streamable HTTP
 * transport), or use {@link serveStdio}.
 */
export function buildMcpServer(registry: Registry, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: opts.name ?? "verbspec-mcp",
    version: opts.version ?? "0.0.0",
  });
  const keep = opts.filter ?? (() => true);
  for (const v of Object.values(registry)) if (keep(v)) registerVerb(server, v);
  return server;
}

/**
 * Serve `registry` as an MCP server over stdio (the transport MCP clients launch by default).
 *
 * Owns **stdout hygiene**: the SDK writes JSON-RPC frames to `process.stdout`, so a verb that
 * `console.log`s during `run()` would interleave and corrupt the stream. We redirect the console
 * sinks (`log`/`info`/`debug`) to stderr — in Bun these write to fd 1 natively, so patching
 * `process.stdout` alone is not enough — while leaving `process.stdout` itself free for the SDK.
 * (A verb writing to `process.stdout` directly is unsupported; use stderr for diagnostics.)
 */
export async function serveStdio(registry: Registry, opts: McpServerOptions = {}): Promise<void> {
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);
  const server = buildMcpServer(registry, opts);
  await server.connect(new StdioServerTransport());
}

export type { McpServer };
