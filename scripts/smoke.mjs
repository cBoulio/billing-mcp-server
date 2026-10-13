// Spawns the built server over stdio, the way Claude Desktop or Claude Code would, and exercises it.
// Run `npm run build` first. Exits non-zero if anything is off.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe" });
const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

const client = new Client({ name: "smoke-test", version: "0.0.0" });
await client.connect(transport);

const info = client.getServerVersion();
console.log(`server: ${info?.name} ${info?.version}`);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

const { resources } = await client.listResources();
const { resourceTemplates } = await client.listResourceTemplates();
const { prompts } = await client.listPrompts();
console.log(`resources: ${resources.length} (templates: ${resourceTemplates.map((t) => t.uriTemplate).join(", ")})`);
console.log(`prompts: ${prompts.map((p) => p.name).join(", ")}`);

const lookup = await client.callTool({ name: "lookup_account", arguments: { email: "dana.whitfield@example.com" } });
console.log(`lookup_account -> isError=${lookup.isError ?? false} ${JSON.stringify(lookup.structuredContent)}`);

const refund = await client.callTool({
  name: "issue_refund",
  arguments: { account_id: "acct_1001", invoice_id: "inv_5002", amount_cents: 4900, reason: "Duplicate charge" },
});
console.log(`issue_refund inv_5002 -> isError=${refund.isError ?? false} ${refund.structuredContent?.message}`);

const blocked = await client.callTool({
  name: "issue_refund",
  arguments: { account_id: "acct_1004", invoice_id: "inv_5301", amount_cents: 9900, reason: "Customer asked" },
});
console.log(`issue_refund inv_5301 -> isError=${blocked.isError ?? false} ${blocked.content[0]?.text}`);

await client.close();

const audit = stderr.join("").split("\n").filter((l) => l.startsWith("[audit]"));
console.log(`audit lines on stderr: ${audit.length}`);

const failures = [];
if (tools.length !== 6) failures.push(`expected 6 tools, got ${tools.length}`);
if (lookup.isError) failures.push("lookup_account failed");
if (refund.isError) failures.push("refund failed");
if (!blocked.isError) failures.push("chargeback refund was not blocked");
if (audit.length !== 2) failures.push(`expected 2 audit lines, got ${audit.length}`);
if (failures.length) {
  console.error(`SMOKE FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("smoke test passed");
