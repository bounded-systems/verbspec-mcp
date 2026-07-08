---
bump: minor
---
Initial release: turn a verbspec verb Registry into an MCP server. `buildMcpServer` registers every verb as an MCP tool (input/output from the verb's own Zod schemas; object outputs returned as structured content), and `serveStdio` runs it over stdio with stdout hygiene, on the official @modelcontextprotocol/sdk.
