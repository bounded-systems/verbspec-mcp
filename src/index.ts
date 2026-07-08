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
// This is the generic base every MCP server in the org builds on. Topic-specific layers hook in
// through the small seams on `McpServerOptions` (`deps` to inject a capability slice into every
// verb's run, `mapResult` to shape the tool result) without forking the server — e.g. static-mcp
// (verified static-site builds) threads its verifying client via `deps` and renders verified bytes
// + provenance `_meta` via `mapResult`. `buildMcpServer` returns the configured `McpServer` so a
// caller can attach any transport (HTTP) or register extra surfaces (resources); `serveStdio` /
// `connectStdio` are the stdio one-liners.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  verbToken,
  render,
  toOutputJsonSchema,
  type Registry,
  type AnyVerbSpec,
} from "@bounded-systems/verbspec";

/** The MCP result a tool handler returns (the SDK's `CallToolResult`). */
export type ToolResult = CallToolResult;

/** Options for building/serving a verbspec MCP server. */
export interface McpServerOptions {
  /** Server name advertised in the MCP `initialize` handshake. Default `"verbspec-mcp"`. */
  name?: string;
  /** Server version advertised in the handshake. Default `"0.0.0"`. */
  version?: string;
  /** Optional server instructions advertised in the handshake (how to use the tools). */
  instructions?: string;
  /**
   * Restrict which verbs are exposed as tools (e.g. read-only surfaces, or an actor allowlist).
   * Default: every verb in the registry.
   */
  filter?: (verb: AnyVerbSpec) => boolean;
  /**
   * Inject a shared deps/capability slice into every verb's `run(input, deps)`, overriding each
   * verb's own `deps?()` default. The seam a topic layer uses for dependency injection — e.g.
   * static-mcp threads one verifying client (or a test mock) into every verb.
   */
  deps?: () => unknown;
  /**
   * Override how a verb's output becomes the MCP tool result (content / structuredContent / `_meta`
   * / isError). Default: a JSON text block plus `structuredContent` for object outputs. A topic
   * layer uses this to shape results — e.g. render verified bytes and attach a provenance `_meta`.
   */
  mapResult?: (output: unknown, verb: AnyVerbSpec, args: unknown) => ToolResult | Promise<ToolResult>;
}

/** A JSON Schema is object-shaped iff its top-level `type` is `"object"`. */
const isObjectSchema = (js: unknown): boolean =>
  typeof js === "object" && js !== null && (js as { type?: unknown }).type === "object";

/**
 * True iff the verb declares a Zod output schema whose JSON-Schema projection is an object. Verbs
 * may declare no/loose output (e.g. a verified-fetch verb whose contract is the hash-checked bytes,
 * not a shape) — then we advertise no `outputSchema` and never derive `structuredContent` from the
 * default path. Guards against `toOutputJsonSchema` throwing on an absent/loose output.
 */
function hasObjectOutput(v: AnyVerbSpec): boolean {
  const out = v.output as { safeParse?: unknown } | undefined;
  if (!out || typeof out.safeParse !== "function") return false;
  try {
    return isObjectSchema(toOutputJsonSchema(v));
  } catch {
    return false;
  }
}

/** Register one verb as an MCP tool. See {@link buildMcpServer}. */
function registerVerb(server: McpServer, v: AnyVerbSpec, opts: McpServerOptions): void {
  const outputIsObject = hasObjectOutput(v);
  server.registerTool(
    verbToken(v.id),
    {
      title: v.id,
      description: v.summary,
      // The SDK validates incoming arguments against this schema before calling the handler.
      inputSchema: v.input,
      // `undefined` when the output isn't object-shaped: the SDK then skips advertising +
      // output-validation entirely.
      outputSchema: outputIsObject ? v.output : undefined,
    },
    // `args` arrives already validated/coerced against `v.input` by the SDK. Errors thrown here —
    // and output-schema validation failures — are caught by the SDK and returned as an `isError`
    // tool result (not a transport crash), so a verb that throws surfaces its message to the model.
    async (args: unknown): Promise<CallToolResult> => {
      const out = await v.run(args, opts.deps ? opts.deps() : v.deps?.());
      if (opts.mapResult) return await opts.mapResult(out, v, args);
      const text = render(out); // canonical JSON view — the verb's CLI `render` is CLI-only.
      return outputIsObject
        ? { content: [{ type: "text", text }], structuredContent: out as Record<string, unknown> }
        : { content: [{ type: "text", text }] };
    },
  );
}

/**
 * Build an MCP server exposing every verb in `registry` as a tool. Returns the configured
 * {@link McpServer} without connecting a transport — attach one yourself (e.g. a Streamable HTTP
 * transport, or register extra resources), or use {@link serveStdio} / {@link connectStdio}.
 */
export function buildMcpServer(registry: Registry, opts: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: opts.name ?? "verbspec-mcp", version: opts.version ?? "0.0.0" },
    opts.instructions === undefined ? undefined : { instructions: opts.instructions },
  );
  const keep = opts.filter ?? (() => true);
  for (const v of Object.values(registry)) if (keep(v)) registerVerb(server, v, opts);
  return server;
}

/**
 * Connect an already-built server to stdio, owning **stdout hygiene**: the SDK writes JSON-RPC
 * frames to `process.stdout`, so a verb that `console.log`s during `run()` would interleave and
 * corrupt the stream. We redirect the console sinks (`log`/`info`/`debug`) to stderr — in Bun these
 * write to fd 1 natively, so patching `process.stdout` alone is not enough — while leaving
 * `process.stdout` itself free for the SDK. (A verb writing to `process.stdout` directly is
 * unsupported; use stderr for diagnostics.) Reuse this from a server you built yourself (e.g. one
 * that also registers resources) so it inherits the same hygiene.
 */
export async function connectStdio(server: McpServer): Promise<void> {
  console.log = console.error.bind(console);
  console.info = console.error.bind(console);
  console.debug = console.error.bind(console);
  await server.connect(new StdioServerTransport());
}

/** Serve `registry` as an MCP server over stdio (the transport MCP clients launch by default). */
export async function serveStdio(registry: Registry, opts: McpServerOptions = {}): Promise<void> {
  await connectStdio(buildMcpServer(registry, opts));
}

export type { McpServer };
