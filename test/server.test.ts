// End-to-end tests: a real MCP client talks to the server over the SDK's in-memory transport pair.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../src/audit.js";
import { BillingService } from "../src/billing.js";
import { POLICY_URI, createServer } from "../src/server.js";
import { MemoryStore } from "../src/store.js";

const open: Client[] = [];

function newBilling() {
  const audit = new MemoryAuditSink();
  return { billing: new BillingService({ store: new MemoryStore(), audit }), audit };
}

async function connect(billing: BillingService): Promise<Client> {
  const server = createServer(billing);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  open.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe("server metadata", () => {
  it("advertises tools, resources, and prompts, with instructions", async () => {
    const client = await connect(newBilling().billing);
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
    expect(client.getInstructions()).toContain("lookup_account");
  });

  it("lists the six tools with input schemas and behavior annotations", async () => {
    const client = await connect(newBilling().billing);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      ["escalate_to_human", "get_invoice", "issue_refund", "list_invoices", "lookup_account", "search_help_center"].sort(),
    );

    const refund = byName.issue_refund!;
    expect(refund.inputSchema.required).toEqual(expect.arrayContaining(["account_id", "invoice_id", "amount_cents", "reason"]));
    expect(refund.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(refund.outputSchema).toBeDefined();

    for (const name of ["lookup_account", "list_invoices", "get_invoice", "search_help_center"]) {
      expect(byName[name]!.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
    expect(byName.escalate_to_human!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("tools", () => {
  it("runs a full duplicate-charge refund flow", async () => {
    const { billing, audit } = newBilling();
    const client = await connect(billing);

    const account = await call(client, "lookup_account", { email: "dana.whitfield@example.com" });
    expect(account.isError).toBeFalsy();
    expect(account.structuredContent).toMatchObject({ account_id: "acct_1001" });

    const invoices = await call(client, "list_invoices", { account_id: "acct_1001" });
    const rows = (invoices.structuredContent as { invoices: Array<{ invoice_id: string; refundable_cents: number }> }).invoices;
    expect(rows.map((r) => [r.invoice_id, r.refundable_cents])).toEqual([
      ["inv_4901", 0],
      ["inv_5001", 4900],
      ["inv_5002", 4900],
    ]);

    const refund = await call(client, "issue_refund", {
      account_id: "acct_1001",
      invoice_id: "inv_5002",
      amount_cents: 4900,
      reason: "Duplicate charge for Sep 15 - Oct 14",
    });
    expect(refund.isError).toBeFalsy();
    expect(refund.structuredContent).toMatchObject({ session_refunded_cents: 4900, session_remaining_cents: 15100 });
    expect(JSON.parse(text(refund))).toEqual(refund.structuredContent);
    expect(audit.entries.map((e) => e.action)).toEqual(["refund.issued"]);
  });

  it("returns actionable isError results for policy violations", async () => {
    const client = await connect(newBilling().billing);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ account_id: "acct_1004", invoice_id: "inv_5301", amount_cents: 9900 }, "CHARGEBACK_OPEN"],
      [{ account_id: "acct_1006", invoice_id: "inv_5501", amount_cents: 4900 }, "INVOICE_NOT_PAID"],
      [{ account_id: "acct_1003", invoice_id: "inv_5201", amount_cents: 1900 }, "OUTSIDE_REFUND_WINDOW"],
      [{ account_id: "acct_1002", invoice_id: "inv_5101", amount_cents: 118800 }, "SESSION_LIMIT_EXCEEDED"],
      [{ account_id: "acct_1002", invoice_id: "inv_5001", amount_cents: 4900 }, "ACCOUNT_MISMATCH"],
      [{ account_id: "acct_1001", invoice_id: "inv_9999", amount_cents: 100 }, "INVOICE_NOT_FOUND"],
    ];
    for (const [args, code] of cases) {
      const result = await call(client, "issue_refund", { ...args, reason: "test" });
      expect(result.isError, code).toBe(true);
      expect(text(result)).toMatch(new RegExp(`^${code}: `));
      expect(result.structuredContent).toBeUndefined();
    }
  });

  it("returns an error for an unknown email instead of guessing", async () => {
    const client = await connect(newBilling().billing);
    const result = await call(client, "lookup_account", { email: "someone@else.com" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("ACCOUNT_NOT_FOUND");
  });

  it("rejects arguments that fail the input schema", async () => {
    const client = await connect(newBilling().billing);
    const negative = await call(client, "issue_refund", {
      account_id: "acct_1001",
      invoice_id: "inv_5001",
      amount_cents: -100,
      reason: "x",
    });
    expect(negative.isError).toBe(true);
    expect(text(negative)).toMatch(/Input validation error/);

    const missing = await call(client, "issue_refund", { invoice_id: "inv_5001", amount_cents: 100 });
    expect(missing.isError).toBe(true);
  });

  it("counts the refund limit per connection", async () => {
    const { billing } = newBilling();
    const first = await connect(billing);
    const ok = await call(first, "issue_refund", { account_id: "acct_1007", invoice_id: "inv_5601", amount_cents: 14900, reason: "x" });
    expect(ok.isError).toBeFalsy();
    const over = await call(first, "issue_refund", { account_id: "acct_1007", invoice_id: "inv_5602", amount_cents: 7900, reason: "x" });
    expect(over.isError).toBe(true);
    expect(text(over)).toContain("escalate_to_human");

    const ticket = await call(first, "escalate_to_human", { account_id: "acct_1007", summary: "Refund of $79.00 on inv_5602 is over the session limit" });
    expect(ticket.structuredContent).toMatchObject({ ticket_id: "tkt_001", account_id: "acct_1007" });

    const second = await connect(billing);
    const fresh = await call(second, "issue_refund", { account_id: "acct_1007", invoice_id: "inv_5602", amount_cents: 7900, reason: "x" });
    expect(fresh.isError).toBeFalsy();
  });

  it("searches the help center", async () => {
    const client = await connect(newBilling().billing);
    const result = await call(client, "search_help_center", { query: "failed payment retry" });
    const results = (result.structuredContent as { results: Array<{ id: string }> }).results;
    expect(results[0]?.id).toBe("kb-04");
  });

  it("gets a single invoice", async () => {
    const client = await connect(newBilling().billing);
    const result = await call(client, "get_invoice", { invoice_id: "inv_5101" });
    expect(result.structuredContent).toMatchObject({ amount_cents: 118800, refund_blocker: null });
  });
});

describe("resources", () => {
  it("serves the refund policy as markdown", async () => {
    const client = await connect(newBilling().billing);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(POLICY_URI);
    const { contents } = await client.readResource({ uri: POLICY_URI });
    expect(contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect(contents[0] && "text" in contents[0] ? contents[0].text : "").toContain("[enforced]");
  });

  it("exposes invoice and account templates and lists their instances", async () => {
    const client = await connect(newBilling().billing);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "larkspur://accounts/{account_id}",
      "larkspur://invoices/{invoice_id}",
    ]);
    const { resources } = await client.listResources();
    expect(resources.filter((r) => r.uri.startsWith("larkspur://invoices/"))).toHaveLength(14);
    expect(resources.filter((r) => r.uri.startsWith("larkspur://accounts/"))).toHaveLength(7);
  });

  it("reads an invoice and an account, reflecting refunds", async () => {
    const client = await connect(newBilling().billing);
    await call(client, "issue_refund", { account_id: "acct_1001", invoice_id: "inv_5002", amount_cents: 4900, reason: "Duplicate" });

    const inv = await client.readResource({ uri: "larkspur://invoices/inv_5002" });
    const invoice = JSON.parse((inv.contents[0] as { text: string }).text);
    expect(invoice).toMatchObject({ invoice_id: "inv_5002", refunded_cents: 4900 });

    const acct = await client.readResource({ uri: "larkspur://accounts/acct_1001" });
    const account = JSON.parse((acct.contents[0] as { text: string }).text);
    expect(account.account.name).toBe("Dana Whitfield");
    expect(account.invoices).toHaveLength(3);
    expect(account.refunds).toHaveLength(1);
  });

  it("returns a resource-not-found error for unknown ids", async () => {
    const client = await connect(newBilling().billing);
    const err = await client.readResource({ uri: "larkspur://invoices/inv_0000" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(-32002);
    await expect(client.readResource({ uri: "larkspur://nothing/here" })).rejects.toThrow();
  });

  it("completes template variables", async () => {
    const client = await connect(newBilling().billing);
    const result = await client.complete({
      ref: { type: "ref/resource", uri: "larkspur://invoices/{invoice_id}" },
      argument: { name: "invoice_id", value: "inv_50" },
    });
    expect(result.completion.values).toEqual(["inv_5001", "inv_5002"]);
  });
});

describe("prompts", () => {
  it("lists both prompts with their arguments", async () => {
    const client = await connect(newBilling().billing);
    const { prompts } = await client.listPrompts();
    const refund = prompts.find((p) => p.name === "handle_refund_request");
    expect(refund?.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
      ["email", true],
      ["customer_message", true],
      ["invoice_id", false],
    ]);
    expect(prompts.map((p) => p.name)).toContain("summarize_account");
  });

  it("builds a refund prompt with the policy embedded and the customer text fenced", async () => {
    const client = await connect(newBilling().billing);
    const result = await client.getPrompt({
      name: "handle_refund_request",
      arguments: { email: "dana.whitfield@example.com", customer_message: "I was charged twice in September." },
    });
    expect(result.messages).toHaveLength(2);
    const [policy, task] = result.messages;
    expect(policy?.content).toMatchObject({ type: "resource", resource: { uri: POLICY_URI } });
    expect(task?.content.type).toBe("text");
    const body = task?.content.type === "text" ? task.content.text : "";
    expect(body).toContain("<customer_message>\nI was charged twice in September.\n</customer_message>");
    expect(body).toContain("Invoice mentioned: none");
  });

  it("builds an account summary prompt", async () => {
    const client = await connect(newBilling().billing);
    const result = await client.getPrompt({ name: "summarize_account", arguments: { email: "priya.n@example.com" } });
    const content = result.messages[0]?.content;
    expect(content?.type === "text" ? content.text : "").toContain("priya.n@example.com");
  });

  it("rejects a prompt call with a missing required argument", async () => {
    const client = await connect(newBilling().billing);
    await expect(client.getPrompt({ name: "handle_refund_request", arguments: { email: "a@b.c" } })).rejects.toThrow(
      /Invalid arguments/,
    );
  });

  it("completes account emails for prompt arguments", async () => {
    const client = await connect(newBilling().billing);
    const result = await client.complete({
      ref: { type: "ref/prompt", name: "summarize_account" },
      argument: { name: "email", value: "da" },
    });
    expect(result.completion.values).toEqual(["dana.whitfield@example.com"]);
  });
});
