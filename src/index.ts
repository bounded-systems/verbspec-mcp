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
//
// A large registry registered verb-by-verb means that many tool schemas in every request of every
// session — that degrades a client's tool-selection accuracy and spends context nobody asked to
// spend. `opts.dispatch` is the alternative: a fixed-size discover/dispatch tool pair
// (`discover_verbs` + `dispatch_verb`) that reaches the WHOLE registry through two tool schemas
// instead of N. It composes with `filter` rather than replacing it — register a small hot set
// directly (unchanged) and opt into the pair to keep the long tail reachable too.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  verbToken,
  render,
  toInputJsonSchema,
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
  /**
   * Additionally register a fixed-size {@link DISCOVER_TOOL_NAME}/{@link DISPATCH_TOOL_NAME} tool
   * pair that covers the WHOLE registry, independent of `filter`. A registry of hundreds of verbs
   * registered directly means hundreds of tool schemas in every request of every session — this is
   * the alternative: discover searches by id substring, summary keyword, or `actor`; dispatch runs
   * any verb by id, validating `args` against THAT verb's own input schema and returning the same
   * result shape a directly-registered tool would. Composes with `filter`: keep registering a small
   * hot set directly (unchanged) and opt into this pair to keep the long tail reachable without
   * paying its per-tool context cost. Default `false` — fully additive; omitting or passing `false`
   * leaves every existing behavior, including `filter`, unchanged.
   */
  dispatch?: boolean;
}

/** Tool name registered for verb discovery when {@link McpServerOptions.dispatch} is on. */
export const DISCOVER_TOOL_NAME = "discover_verbs";
/** Tool name registered for verb dispatch when {@link McpServerOptions.dispatch} is on. */
export const DISPATCH_TOOL_NAME = "dispatch_verb";

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

/**
 * Run `v` and shape its output into a tool result — the one place that turns a verb's return value
 * into content/structuredContent/mapResult, so a directly-registered tool and a dispatched one
 * produce identically-shaped results. `args` here is already validated against `v.input`, by the
 * SDK for a directly-registered tool ({@link registerVerb}) and explicitly, by us, for
 * {@link registerDispatchTool} (whose own declared input is the dispatch envelope, not the target
 * verb's). Errors thrown here are caught by the SDK/dispatch handler and returned as an `isError`
 * tool result, not a transport crash — a verb that throws surfaces its message to the model either
 * way. Also the reuse seam for stdout hygiene: `v.run` here is called exactly as it would be from a
 * direct tool, so a verb that `console.log`s during `run()` is protected by the SAME global
 * redirection {@link connectStdio} installs before the transport connects — there is no separate
 * guard to reimplement for dispatch, because that hygiene is a property of the process, not of
 * which tool triggered the call.
 */
async function runVerb(
  v: AnyVerbSpec,
  args: unknown,
  opts: McpServerOptions,
): Promise<CallToolResult> {
  const out = await v.run(args, opts.deps ? opts.deps() : v.deps?.());
  if (opts.mapResult) return await opts.mapResult(out, v, args);
  const text = render(out); // canonical JSON view — the verb's CLI `render` is CLI-only.
  return hasObjectOutput(v)
    ? { content: [{ type: "text", text }], structuredContent: out as Record<string, unknown> }
    : { content: [{ type: "text", text }] };
}

/** Register one verb as an MCP tool. See {@link buildMcpServer}. */
function registerVerb(server: McpServer, v: AnyVerbSpec, opts: McpServerOptions): void {
  server.registerTool(
    verbToken(v.id),
    {
      title: v.id,
      description: v.summary,
      // The SDK validates incoming arguments against this schema before calling the handler.
      inputSchema: v.input,
      // `undefined` when the output isn't object-shaped: the SDK then skips advertising +
      // output-validation entirely.
      outputSchema: hasObjectOutput(v) ? v.output : undefined,
    },
    // `args` arrives already validated/coerced against `v.input` by the SDK.
    async (args: unknown): Promise<CallToolResult> => runVerb(v, args, opts),
  );
}

/** {@link DISCOVER_TOOL_NAME}'s own input — search terms, not a verb's input. */
const discoverInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Case-insensitive substring to match against a verb's id or summary."),
  actor: z.string().optional().describe("Restrict to verbs owned by this exact actor."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Cap the number of matches returned. Default 20."),
});

/** {@link DISCOVER_TOOL_NAME}'s own output — matches, each carrying its verb's input schema. */
const discoverOutputSchema = z.object({
  verbs: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      actor: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  ),
  total: z.number().int(),
});

/**
 * Register the discovery half of the pair: search the WHOLE registry — every verb, regardless of
 * `filter` — by id substring, summary keyword, or `actor` (the one grouping a `VerbSpec` already
 * carries; there is no richer taxonomy at this layer to search by). Feed a returned `id` straight to
 * {@link DISPATCH_TOOL_NAME}. See {@link McpServerOptions.dispatch}.
 */
function registerDiscoverTool(server: McpServer, registry: Registry): void {
  server.registerTool(
    DISCOVER_TOOL_NAME,
    {
      title: "Discover verbs",
      description:
        "Search the full verb registry (including verbs not directly registered as their own " +
        "tool) by id substring, summary keyword, or actor. Returns matching verb ids with their " +
        `summary and input schema — pass an id to ${DISPATCH_TOOL_NAME} to run it.`,
      inputSchema: discoverInputSchema,
      outputSchema: discoverOutputSchema,
    },
    async ({ query, actor, limit }): Promise<CallToolResult> => {
      const q = query?.trim().toLowerCase();
      const matches = Object.values(registry).filter((v) => {
        if (actor !== undefined && v.actor !== actor) return false;
        if (!q) return true;
        return v.id.toLowerCase().includes(q) || v.summary.toLowerCase().includes(q);
      });
      const verbs = matches.slice(0, limit ?? 20).map((v) => ({
        id: v.id,
        summary: v.summary,
        actor: v.actor,
        inputSchema: toInputJsonSchema(v),
      }));
      const structuredContent = { verbs, total: matches.length };
      return { content: [{ type: "text", text: render(structuredContent) }], structuredContent };
    },
  );
}

/** {@link DISPATCH_TOOL_NAME}'s own input — the dispatch envelope, not any one verb's input. */
const dispatchInputSchema = z.object({
  id: z.string().describe("A verb id, e.g. one returned by " + DISCOVER_TOOL_NAME + "."),
  args: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments for that verb's own input schema."),
});

/**
 * Register the dispatch half of the pair: run any verb in `registry` by id — including one this
 * server never registered directly — validating `args` against THAT verb's own input schema (the
 * SDK only validated the dispatch envelope above; the target verb's schema is checked here, by us)
 * and returning the same result shape a directly-registered tool would, via {@link runVerb}. See
 * {@link McpServerOptions.dispatch}.
 */
function registerDispatchTool(server: McpServer, registry: Registry, opts: McpServerOptions): void {
  server.registerTool(
    DISPATCH_TOOL_NAME,
    {
      title: "Dispatch a verb",
      description:
        "Run any verb in the registry by id, including one not directly registered as its own " +
        "tool. `args` is validated against that verb's own input schema before it runs, and the " +
        "result has the same shape a directly-registered tool would return.",
      inputSchema: dispatchInputSchema,
      // No outputSchema: which verb runs — and so its output shape — is only known at call time,
      // unlike a per-verb tool whose outputSchema is that one verb's fixed `v.output`.
    },
    async ({ id, args }): Promise<CallToolResult> => {
      const v = registry[id];
      if (!v) throw new Error(`unknown verb: ${JSON.stringify(id)}`);
      const parsed = v.input.safeParse(args ?? {});
      if (!parsed.success) {
        throw new Error(`invalid arguments for verb ${JSON.stringify(id)}: ${parsed.error.message}`);
      }
      return runVerb(v, parsed.data, opts);
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
  if (opts.dispatch) {
    registerDiscoverTool(server, registry);
    registerDispatchTool(server, registry, opts);
  }
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
