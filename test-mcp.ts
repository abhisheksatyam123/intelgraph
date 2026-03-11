import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const server = new McpServer({ name: "test", version: "1" });
server.tool("my_tool", "desc", { "foo": { type: "string"} } as any, async (args) => { return {}; });

async function main() {
  const tools = await server.server.listTools();
  console.log(JSON.stringify(tools, null, 2));
}
main();
EOF
