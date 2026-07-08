# @bounded-systems/verbspec-mcp

Turn any [`@bounded-systems/verbspec`](https://jsr.io/@bounded-systems/verbspec)
verb **`Registry`** into a real **[MCP](https://modelcontextprotocol.io) server**.

verbspec authors each check/generator **once** as a typed `VerbSpec` (Zod
input/output + a business-meaning summary) and projects it to CLI, Anthropic,
OpenAPI, and OpenRPC surfaces — and to MCP *tool descriptors*. What it
deliberately does **not** ship is a server: the MCP wire protocol, the
transport, and result-wrapping. This package is that missing layer, built on the
official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).
Hand it a registry, get a server:

```ts
import { serveStdio } from "@bounded-systems/verbspec-mcp";
import { registry } from "./registry";

await serveStdio(registry, { name: "spd", version: "0.1.0" });
```

Every verb becomes an MCP tool whose `inputSchema`/`outputSchema` **are the
verb's own Zod schemas** (zero drift), and whose handler runs the verb. Object-
shaped outputs are returned as MCP `structuredContent` (and advertised as an
`outputSchema`); other outputs degrade to text. A verb that throws surfaces as an
`isError` tool result, not a transport crash.

## Where this sits

One verb spec, projected everywhere — and every MCP server in the org is the same
shape: **verbspec verbs → this base → an optional topic layer.**

```
verbspec                author each verb once (Zod input/output + a summary)
  └── verbspec-mcp       the base — any verb Registry → MCP tools   (this package)
        └── <topic>-mcp  optional, domain-specific layers on top, e.g.:
              • verified static-site / website builds — adds read-only,
                Sigstore-verified static responses + a resource catalog
                (today: @bounded-systems/static-mcp)
```

`verbspec-mcp` is the only mandatory piece: it just **runs the verbs** (checks,
generators, mutations — whatever they do). Anything domain-specific is an
*option* stacked on top — still nothing but verbspec verbs plus this base plus
its own middleware. "Serve a verified website build" is one such topic, not the
core; use the base alone to expose any live verb registry as tools.

## Install

Published to both registries so either ecosystem can consume it:

```bash
deno add jsr:@bounded-systems/verbspec-mcp        # Deno / JSR-native
npm install @bounded-systems/verbspec-mcp         # Node / npm (+ Bun)
```

`@modelcontextprotocol/sdk` is a normal dependency; `@bounded-systems/verbspec`
is a **peer** — the server shares your project's verbspec instance (and its
`zod`), so there's no dual-package split.

## API

```ts
interface McpServerOptions {
  name?: string;                           // handshake server name (default "verbspec-mcp")
  version?: string;                        // handshake version     (default "0.0.0")
  instructions?: string;                   // handshake instructions (how to use the tools)
  filter?: (verb: AnyVerbSpec) => boolean; // restrict which verbs are exposed
  deps?: () => unknown;                    // inject a shared deps slice into every verb's run
  mapResult?: (out, verb, args) => ToolResult | Promise<ToolResult>; // shape the tool result
}

// Build the configured SDK server WITHOUT a transport — attach your own (e.g. HTTP),
// or register extra surfaces (resources) on the returned server.
function buildMcpServer(registry: Registry, opts?: McpServerOptions): McpServer;

// buildMcpServer + connectStdio. The one-liner most servers want.
function serveStdio(registry: Registry, opts?: McpServerOptions): Promise<void>;

// Connect a server you built yourself to stdio, with stdout hygiene. For servers that
// also register resources and can't use the serveStdio shortcut.
function connectStdio(server: McpServer): Promise<void>;
```

For an HTTP server, take `buildMcpServer(...)` and `.connect()` it to a
Streamable HTTP transport from the SDK.

### Topic layers: `deps` + `mapResult`

A domain-specific server stacks on the base through two seams instead of forking
it. `deps` injects a shared capability slice into every verb's `run(input, deps)`
(dependency injection — one client, or a test mock, for all verbs). `mapResult`
takes control of how a verb's output becomes the tool result (content,
`structuredContent`, `_meta`, `isError`). For example, the verified static-site
layer threads its verifying client via `deps` and renders verified bytes +
provenance `_meta` via `mapResult` — while the base still owns registration,
schema validation, and running the verb.

### stdout hygiene

`serveStdio` redirects `console.log`/`info`/`debug` to **stderr**. The SDK writes
JSON-RPC frames to `process.stdout`, so a verb that logs progress during `run()`
would otherwise interleave and corrupt the stream (in Bun, `console.log` writes
to fd 1 natively — patching `process.stdout` alone would miss it). Verbs must not
write to `process.stdout` directly; use stderr for diagnostics.

## License

MIT
