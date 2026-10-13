import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../src/audit.js";
import { BillingError, BillingService, type BillingErrorCode } from "../src/billing.js";
import { formatCents, policyMarkdown, refundWindowStart } from "../src/policy.js";
import { MemoryStore } from "../src/store.js";

function setup(today?: string) {
  const audit = new MemoryAuditSink();
  const billing = new BillingService({
    store: new MemoryStore(),
    audit,
    ...(today ? { today } : {}),
    now: () => new Date("2026-10-01T12:00:00Z"),
  });
  return { billing, audit, session: billing.openSession() };
}

function expectCode(fn: () => unknown, code: BillingErrorCode): BillingError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BillingError);
    expect((err as BillingError).code).toBe(code);
    return err as BillingError;
  }
  throw new Error(`expected BillingError ${code}, but nothing was thrown`);
}

describe("policy helpers", () => {
  it("formats cents as dollars", () => {
    expect(formatCents(4900)).toBe("$49.00");
    expect(formatCents(118800)).toBe("$1,188.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(-250)).toBe("-$2.50");
  });

  it("computes the 30-day window from today", () => {
    expect(refundWindowStart("2026-10-01")).toBe("2026-09-01");
    expect(refundWindowStart("2026-03-01")).toBe("2026-01-30");
  });

  it("states today and the window start in the policy text", () => {
    const text = policyMarkdown();
    expect(text).toContain("Today is 2026-10-01");
    expect(text).toContain("on or after 2026-09-01");
    expect(text).toContain("$200.00");
  });
});

describe("reads", () => {
  it("looks up accounts by email, ignoring case and whitespace", () => {
    const { billing } = setup();
    expect(billing.lookupAccount("  Dana.Whitfield@Example.com ").account_id).toBe("acct_1001");
  });

  it("tells the model to ask for the right email when none matches", () => {
    const { billing } = setup();
    const err = expectCode(() => billing.lookupAccount("nobody@example.com"), "ACCOUNT_NOT_FOUND");
    expect(err.message).toMatch(/Ask the customer/);
  });

  it("lists an account's invoices oldest first", () => {
    const { billing } = setup();
    const ids = billing.listInvoices("acct_1001").invoices.map((i) => i.invoice_id);
    expect(ids).toEqual(["inv_4901", "inv_5001", "inv_5002"]);
  });

  it("rejects unknown accounts and invoices with a next step", () => {
    const { billing } = setup();
    expect(expectCode(() => billing.listInvoices("acct_9999"), "ACCOUNT_NOT_FOUND").message).toMatch(/lookup_account/);
    expect(expectCode(() => billing.getInvoice("inv_0000"), "INVOICE_NOT_FOUND").message).toMatch(/list_invoices/);
  });

  it("explains on each invoice whether and how much it can be refunded", () => {
    const { billing } = setup();
    expect(billing.getInvoice("inv_5001")).toMatchObject({ refundable_cents: 4900, refund_blocker: null });
    expect(billing.getInvoice("inv_4901")).toMatchObject({ refundable_cents: 0, refund_blocker: "OUTSIDE_REFUND_WINDOW" });
    expect(billing.getInvoice("inv_5501")).toMatchObject({ refundable_cents: 0, refund_blocker: "INVOICE_NOT_PAID" });
    expect(billing.getInvoice("inv_5301")).toMatchObject({ refundable_cents: 0, refund_blocker: "CHARGEBACK_OPEN" });
  });

  it("searches the help center with the same scoring as the eval harness", () => {
    const { billing } = setup();
    const { results } = billing.searchHelpCenter("how do I download an invoice PDF");
    expect(results[0]?.id).toBe("kb-01");
    expect(results.length).toBeLessThanOrEqual(2);
    expect(billing.searchHelpCenter("zz qq").results).toEqual([]);
  });
});

describe("issue_refund guardrails", () => {
  it("refunds a duplicate charge in full and reports the session budget", () => {
    const { billing, session } = setup();
    const result = billing.issueRefund(session, {
      account_id: "acct_1001",
      invoice_id: "inv_5002",
      amount_cents: 4900,
      reason: "Duplicate charge",
    });
    expect(result.refund).toMatchObject({ refund_id: "rf_001", invoice_id: "inv_5002", amount_cents: 4900 });
    expect(result.invoice).toMatchObject({ refunded_cents: 4900, refundable_cents: 0, refund_blocker: "ALREADY_FULLY_REFUNDED" });
    expect(result.session_refunded_cents).toBe(4900);
    expect(result.session_remaining_cents).toBe(15100);
  });

  it("supports partial refunds up to what is left on the invoice", () => {
    const { billing, session } = setup();
    const base = { account_id: "acct_1005", invoice_id: "inv_5401", reason: "Partial credit" };
    billing.issueRefund(session, { ...base, amount_cents: 2000 });
    const err = expectCode(() => billing.issueRefund(session, { ...base, amount_cents: 6000 }), "INVALID_AMOUNT");
    expect(err.message).toContain("between 1 and 5900");
    expect(billing.issueRefund(session, { ...base, amount_cents: 5900 }).refund.refund_id).toBe("rf_002");
    expectCode(() => billing.issueRefund(session, { ...base, amount_cents: 1 }), "ALREADY_FULLY_REFUNDED");
  });

  it("rejects non-positive and fractional amounts", () => {
    const { billing, session } = setup();
    const base = { account_id: "acct_1001", invoice_id: "inv_5001", reason: "x" };
    expectCode(() => billing.issueRefund(session, { ...base, amount_cents: 0 }), "INVALID_AMOUNT");
    expectCode(() => billing.issueRefund(session, { ...base, amount_cents: 10.5 }), "INVALID_AMOUNT");
  });

  it("blocks refunds on accounts with an open chargeback and points to escalation", () => {
    const { billing, session } = setup();
    const err = expectCode(
      () => billing.issueRefund(session, { account_id: "acct_1004", invoice_id: "inv_5301", amount_cents: 9900, reason: "x" }),
      "CHARGEBACK_OPEN",
    );
    expect(err.message).toContain("escalate_to_human");
  });

  it("blocks refunds on failed payments", () => {
    const { billing, session } = setup();
    const err = expectCode(
      () => billing.issueRefund(session, { account_id: "acct_1006", invoice_id: "inv_5501", amount_cents: 4900, reason: "x" }),
      "INVOICE_NOT_PAID",
    );
    expect(err.message).toContain("was not charged");
  });

  it("blocks refunds outside the 30-day window, with the boundary inclusive", () => {
    const { billing, session } = setup();
    expectCode(
      () => billing.issueRefund(session, { account_id: "acct_1006", invoice_id: "inv_5500", amount_cents: 4900, reason: "x" }),
      "OUTSIDE_REFUND_WINDOW",
    );
    // inv_5203 is dated 2026-09-02: inside the window today, on the boundary a day later, out two days later.
    const onBoundary = setup("2026-10-02");
    expect(
      onBoundary.billing.issueRefund(onBoundary.session, { account_id: "acct_1003", invoice_id: "inv_5203", amount_cents: 1900, reason: "x" }).refund,
    ).toBeDefined();
    const past = setup("2026-10-03");
    expectCode(
      () => past.billing.issueRefund(past.session, { account_id: "acct_1003", invoice_id: "inv_5203", amount_cents: 1900, reason: "x" }),
      "OUTSIDE_REFUND_WINDOW",
    );
  });

  it("refuses to refund an invoice that belongs to another account", () => {
    const { billing, session } = setup();
    expectCode(
      () => billing.issueRefund(session, { account_id: "acct_1002", invoice_id: "inv_5001", amount_cents: 4900, reason: "x" }),
      "ACCOUNT_MISMATCH",
    );
  });

  it("enforces the $200 limit across a session without issuing partial refunds", () => {
    const { billing, session } = setup();
    billing.issueRefund(session, { account_id: "acct_1007", invoice_id: "inv_5601", amount_cents: 14900, reason: "x" });
    const err = expectCode(
      () => billing.issueRefund(session, { account_id: "acct_1007", invoice_id: "inv_5602", amount_cents: 7900, reason: "x" }),
      "SESSION_LIMIT_EXCEEDED",
    );
    expect(err.message).toContain("Do not issue a partial refund");
    expect(billing.getInvoice("inv_5602").refunded_cents).toBe(0);
    expect(billing.sessionRefundedCents(session)).toBe(14900);

    // A different session has its own budget.
    const other = billing.openSession();
    expect(billing.issueRefund(other, { account_id: "acct_1007", invoice_id: "inv_5602", amount_cents: 7900, reason: "x" })).toBeDefined();
  });

  it("rejects a single refund larger than the session limit", () => {
    const { billing, session } = setup();
    expectCode(
      () => billing.issueRefund(session, { account_id: "acct_1002", invoice_id: "inv_5101", amount_cents: 118800, reason: "x" }),
      "SESSION_LIMIT_EXCEEDED",
    );
  });

  it("audits issued and rejected refunds", () => {
    const { billing, session, audit } = setup();
    billing.issueRefund(session, { account_id: "acct_1001", invoice_id: "inv_5002", amount_cents: 4900, reason: "Duplicate" });
    expect(() =>
      billing.issueRefund(session, { account_id: "acct_1001", invoice_id: "inv_4901", amount_cents: 4900, reason: "Old" }),
    ).toThrow(BillingError);
    expect(audit.entries.map((e) => e.action)).toEqual(["refund.issued", "refund.rejected"]);
    expect(audit.entries[0]).toMatchObject({ session_id: session.id, refund_id: "rf_001", invoice_id: "inv_5002" });
    expect(audit.entries[1]).toMatchObject({ code: "OUTSIDE_REFUND_WINDOW", invoice_id: "inv_4901" });
  });
});

describe("escalate_to_human", () => {
  it("opens numbered tickets and audits them", () => {
    const { billing, session, audit } = setup();
    const t1 = billing.escalateToHuman(session, "acct_1004", "Refund requested during open chargeback");
    const t2 = billing.escalateToHuman(session, "acct_1002", "Annual plan refund over limit");
    expect(t1).toMatchObject({ ticket_id: "tkt_001", expected_response: "within 1 business day" });
    expect(t2.ticket_id).toBe("tkt_002");
    expect(billing.escalationsFor("acct_1004")).toHaveLength(1);
    expect(audit.entries.filter((e) => e.action === "escalation.created")).toHaveLength(2);
  });

  it("rejects unknown accounts", () => {
    const { billing, session } = setup();
    expectCode(() => billing.escalateToHuman(session, "acct_0000", "x"), "ACCOUNT_NOT_FOUND");
  });
});
