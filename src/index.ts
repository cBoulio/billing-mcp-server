#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileAuditSink, StderrAuditSink, type AuditSink } from "./audit.js";
import { BillingService } from "./billing.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { JsonFileStore, MemoryStore, type StateStore } from "./store.js";

const USAGE = `Usage: larkspur-billing-mcp [--state <file>] [--reset] [--audit-log <file>]

Runs the Larkspur Billing MCP server over stdio.

  --state <file>      Keep refunds and tickets in a JSON file so they survive restarts.
                      Env: LARKSPUR_STATE_FILE. Default: in memory.
  --reset             Start the state file fresh (discards refunds and tickets in it).
  --audit-log <file>  Append the audit log (JSON lines) to a file. Env: LARKSPUR_AUDIT_LOG.
                      Default: stderr.
  -h, --help          Show this help.`;

/** stdout is the JSON-RPC channel, so every human-facing message goes to stderr. */
function log(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      state: { type: "string" },
      reset: { type: "boolean", default: false },
      "audit-log": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }

  const statePath = values.state ?? process.env.LARKSPUR_STATE_FILE;
  const auditPath = values["audit-log"] ?? process.env.LARKSPUR_AUDIT_LOG;

  const store: StateStore = statePath ? new JsonFileStore(statePath, { reset: values.reset }) : new MemoryStore();
  const audit: AuditSink = auditPath ? new FileAuditSink(auditPath) : new StderrAuditSink();
  if (values.reset && statePath) {
    audit.write({ ts: new Date().toISOString(), session_id: "startup", action: "state.reset", state: store.description });
  }

  const billing = new BillingService({ store, audit });
  const server = createServer(billing);
  await server.connect(new StdioServerTransport());
  log(`v${SERVER_VERSION} ready on stdio. State: ${store.description}. Audit: ${auditPath ?? "stderr"}.`);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
