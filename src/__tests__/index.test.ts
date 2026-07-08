// Drive a built server through the SDK's in-memory client/server pair — no stdio needed. Covers
// tools/list projection, tools/call structured output, the isError path, a filter, and that a verb
// which console.logs during run() still returns cleanly. (The stdout-purity guarantee of serveStdio
// is a stdio-transport property, exercised end-to-end by the spd consumer, not here.)

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineVerb, type Registry } from "@bounded-systems/verbspec";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../index";

const echo = defineVerb({
  id: "echo",
  summary: "Echo the message back with its length.",
  actor: "test",
  input: z.object({ message: z.string() }),
  output: z.object({ message: z.string(), length: z.number() }),
  run: ({ message }) => ({ message, length: message.length }),
});

// Multi-word id → MCP tool name is tokenized ("noisy check" → "noisy_check").
const noisy = defineVerb({
  id: "noisy check",
  summary: "Writes to stdout during run — must not break the call.",
  actor: "test",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  run: () => {
    console.log("✓ noisy verb chatter that would corrupt a raw stdio stream");
    return { ok: true };
  },
});

const boom = defineVerb({
  id: "boom",
  summary: "Always throws.",
  actor: "test",
  input: z.object({}),
  output: z.object({ never: z.string() }),
  run: (): { never: string } => {
    throw new Error("kaboom");
  },
});

const registry: Registry = { [echo.id]: echo, [noisy.id]: noisy, [boom.id]: boom };

async function connectClient(reg: Registry, opts?: Parameters<typeof buildMcpServer>[1]): Promise<Client> {
  const server = buildMcpServer(reg, opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "probe", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("buildMcpServer", () => {
  it("projects every verb to a tool with tokenized name + input/output schema", async () => {
    const client = await connectClient(registry);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(["boom", "echo", "noisy_check"]);
    expect(byName.echo!.description).toBe("Echo the message back with its length.");
    expect(byName.echo!.inputSchema.properties).toHaveProperty("message");
    // Object-shaped output → outputSchema advertised for structured-content clients.
    expect(byName.echo!.outputSchema?.properties).toHaveProperty("length");
  });

  it("runs a verb and returns both text and structured content", async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: "echo", arguments: { message: "hi" } });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ message: "hi", length: 2 });
    expect(JSON.parse((res.content as { type: string; text: string }[])[0]!.text)).toEqual({
      message: "hi",
      length: 2,
    });
  });

  it("survives a verb that writes to stdout during run", async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: "noisy_check", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ ok: true });
  });

  it("surfaces a thrown verb as an isError result, not a transport crash", async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: "boom", arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as { type: string; text: string }[])[0]!.text).toContain("kaboom");
  });

  it("rejects invalid input against the verb's Zod schema", async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: "echo", arguments: { message: 123 } });
    expect(res.isError).toBe(true);
  });

  it("honors the filter option", async () => {
    const client = await connectClient(registry, { filter: (v) => v.id === "echo" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
  });
});
