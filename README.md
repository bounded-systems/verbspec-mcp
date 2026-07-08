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

## Not to be confused with `static-mcp`

[`@bounded-systems/static-mcp`](https://jsr.io/@bounded-systems/static-mcp) serves
verbs as a **read-only, Sigstore-verified static-response** server — every result
is checked byte-for-byte against a signed manifest, no mutating surfaces.
`verbspec-mcp` is the plainer, lower layer: it **runs the verbs** (whatever they
do — checks, generators, mutations). Use `static-mcp` for verified static
content; use `verbspec-mcp` to expose a live verb registry as tools.

## Install

Published to both registries so either ecosystem can consume it:

```bash
deno add jsr:@bounded-systems/verbspec-mcp        # Deno / JSR-native
npm install @bounded-systems/verbspec-mcp         # Node / npm (+ Bun)
```

`@modelcontextprotocol/sdk` is a normal dependency; `zod` is a **peer**
(`^3.25 || ^4`) — match the version your verbs are authored with.

## API

```ts
interface McpServerOptions {
  name?: string;                          // handshake server name (default "verbspec-mcp")
  version?: string;                       // handshake version    (default "0.0.0")
  filter?: (verb: AnyVerbSpec) => boolean; // restrict which verbs are exposed
}

// Build the configured SDK server WITHOUT a transport — attach your own (e.g. HTTP).
function buildMcpServer(registry: Registry, opts?: McpServerOptions): McpServer;

// buildMcpServer + stdout hygiene + StdioServerTransport. The one-liner most servers want.
function serveStdio(registry: Registry, opts?: McpServerOptions): Promise<void>;
```

For an HTTP server, take `buildMcpServer(...)` and `.connect()` it to a
Streamable HTTP transport from the SDK.

### stdout hygiene

`serveStdio` redirects `console.log`/`info`/`debug` to **stderr**. The SDK writes
JSON-RPC frames to `process.stdout`, so a verb that logs progress during `run()`
would otherwise interleave and corrupt the stream (in Bun, `console.log` writes
to fd 1 natively — patching `process.stdout` alone would miss it). Verbs must not
write to `process.stdout` directly; use stderr for diagnostics.

## License

MIT
