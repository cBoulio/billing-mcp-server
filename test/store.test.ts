import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAuditSink, MemoryAuditSink } from "../src/audit.js";
import { BillingService } from "../src/billing.js";
import { JsonFileStore, MemoryStore, emptyState } from "../src/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "larkspur-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const refund = { account_id: "acct_1001", invoice_id: "inv_5002", amount_cents: 4900, reason: "Duplicate" };

describe("MemoryStore", () => {
  it("returns copies, so callers cannot mutate stored state", () => {
    const store = new MemoryStore();
    store.load().refunds.push({ ...refund, refund_id: "rf_x", session_id: "s", created_at: "t" });
    expect(store.load()).toEqual(emptyState());
  });
});

describe("JsonFileStore", () => {
  it("creates a fresh state file when none exists", () => {
    const path = join(dir, "nested", "state.json");
    new JsonFileStore(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(emptyState());
  });

  it("keeps refunds across restarts, while the session limit starts over", () => {
    const path = join(dir, "state.json");
    const first = new BillingService({ store: new JsonFileStore(path), audit: new MemoryAuditSink() });
    first.issueRefund(first.openSession(), refund);

    const second = new BillingService({ store: new JsonFileStore(path), audit: new MemoryAuditSink() });
    expect(second.getInvoice("inv_5002").refunded_cents).toBe(4900);
    expect(second.sessionRefundedCents(second.openSession())).toBe(0);
    // The invoice is still fully refunded, so the same refund cannot be issued twice.
    expect(() => second.issueRefund(second.openSession(), refund)).toThrow(/already been refunded/);
  });

  it("continues refund numbering from the saved state", () => {
    const path = join(dir, "state.json");
    const first = new BillingService({ store: new JsonFileStore(path), audit: new MemoryAuditSink() });
    first.issueRefund(first.openSession(), refund);
    const second = new BillingService({ store: new JsonFileStore(path), audit: new MemoryAuditSink() });
    const result = second.issueRefund(second.openSession(), { ...refund, invoice_id: "inv_5001" });
    expect(result.refund.refund_id).toBe("rf_002");
  });

  it("discards saved state on reset", () => {
    const path = join(dir, "state.json");
    const first = new BillingService({ store: new JsonFileStore(path), audit: new MemoryAuditSink() });
    first.issueRefund(first.openSession(), refund);
    const reset = new BillingService({ store: new JsonFileStore(path, { reset: true }), audit: new MemoryAuditSink() });
    expect(reset.getInvoice("inv_5002").refunded_cents).toBe(0);
  });

  it("fails loudly on a corrupt or invalid state file", () => {
    const path = join(dir, "state.json");
    writeFileSync(path, "{not json");
    expect(() => new JsonFileStore(path).load()).toThrow(/--reset/);
    writeFileSync(path, JSON.stringify({ version: 2, refunds: [] }));
    expect(() => new JsonFileStore(path).load()).toThrow(/not valid billing state/);
  });
});

describe("FileAuditSink", () => {
  it("appends one JSON line per entry", () => {
    const path = join(dir, "logs", "audit.jsonl");
    const billing = new BillingService({ store: new MemoryStore(), audit: new FileAuditSink(path) });
    const session = billing.openSession();
    billing.issueRefund(session, refund);
    billing.escalateToHuman(session, "acct_1001", "Follow up");
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(["refund.issued", "escalation.created"]);
  });
});
