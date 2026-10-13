import { randomUUID } from "node:crypto";
import type { AuditEntry, AuditSink } from "./audit.js";
import {
  ACCOUNTS,
  HELP_ARTICLES,
  INVOICES,
  SESSION_REFUND_LIMIT_CENTS,
  TODAY,
  type Account,
  type HelpArticle,
  type Invoice,
} from "./data.js";
import { formatCents, refundWindowStart } from "./policy.js";
import type { BillingState, Escalation, Refund, StateStore } from "./store.js";

/** Machine-readable reason a request was rejected. Shown to the model alongside the message. */
export type BillingErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "INVOICE_NOT_FOUND"
  | "ACCOUNT_MISMATCH"
  | "CHARGEBACK_OPEN"
  | "INVOICE_NOT_PAID"
  | "OUTSIDE_REFUND_WINDOW"
  | "ALREADY_FULLY_REFUNDED"
  | "INVALID_AMOUNT"
  | "SESSION_LIMIT_EXCEEDED";

/**
 * A request the billing system refused. The message is written for the model: it says what went
 * wrong and what to do next, so the model can recover instead of retrying blindly.
 */
export class BillingError extends Error {
  readonly code: BillingErrorCode;

  constructor(code: BillingErrorCode, message: string) {
    super(message);
    this.name = "BillingError";
    this.code = code;
  }
}

/** One MCP connection. The per-session refund limit is counted against this id. */
export interface BillingSession {
  readonly id: string;
}

export interface InvoiceView extends Invoice {
  refunded_cents: number;
  /** How much can be refunded right now under policy (0 if blocked). Ignores the session limit. */
  refundable_cents: number;
  /** Why the invoice cannot be refunded, or null if it can. */
  refund_blocker: string | null;
}

export interface RefundRequest {
  account_id: string;
  invoice_id: string;
  amount_cents: number;
  reason: string;
}

export interface RefundResult {
  refund: Refund;
  invoice: InvoiceView;
  session_refunded_cents: number;
  session_remaining_cents: number;
  message: string;
}

export interface EscalationResult extends Escalation {
  expected_response: string;
}

export interface BillingServiceOptions {
  store: StateStore;
  audit: AuditSink;
  /** The billing system's "today". Defaults to the fictional world's date, 2026-10-01. */
  today?: string;
  /** Wall clock for audit and record timestamps. */
  now?: () => Date;
}

export class BillingService {
  readonly today: string;
  private readonly store: StateStore;
  private readonly audit: AuditSink;
  private readonly now: () => Date;
  private readonly accounts = new Map<string, Account>(ACCOUNTS.map((a) => [a.account_id, a]));
  private readonly invoices = new Map<string, Invoice>(INVOICES.map((i) => [i.invoice_id, i]));
  private state: BillingState;

  constructor(options: BillingServiceOptions) {
    this.store = options.store;
    this.audit = options.audit;
    this.today = options.today ?? TODAY;
    this.now = options.now ?? (() => new Date());
    this.state = this.store.load();
  }

  openSession(): BillingSession {
    return { id: `sess_${randomUUID().replaceAll("-", "").slice(0, 12)}` };
  }

  // --- reads ------------------------------------------------------------------------------------

  listAccounts(): Account[] {
    return [...this.accounts.values()].map((a) => ({ ...a }));
  }

  getAccount(accountId: string): Account {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new BillingError(
        "ACCOUNT_NOT_FOUND",
        `Unknown account_id "${accountId}". Look the customer up by email with lookup_account to get their account_id.`,
      );
    }
    return { ...account };
  }

  lookupAccount(email: string): Account {
    const needle = email.trim().toLowerCase();
    const account = [...this.accounts.values()].find((a) => a.email === needle);
    if (!account) {
      throw new BillingError(
        "ACCOUNT_NOT_FOUND",
        `No account found for email "${email}". Ask the customer for the email address on their ` +
          "Larkspur account. Do not share, change, or refund anything until an account is found.",
      );
    }
    return { ...account };
  }

  listInvoices(accountId: string): { account_id: string; invoices: InvoiceView[] } {
    this.getAccount(accountId);
    const rows = [...this.invoices.values()]
      .filter((i) => i.account_id === accountId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.invoice_id.localeCompare(b.invoice_id))
      .map((i) => this.invoiceView(i));
    return { account_id: accountId, invoices: rows };
  }

  listAllInvoices(): InvoiceView[] {
    return [...this.invoices.values()].map((i) => this.invoiceView(i));
  }

  getInvoice(invoiceId: string): InvoiceView {
    return this.invoiceView(this.requireInvoice(invoiceId));
  }

  refundsFor(accountId: string): Refund[] {
    return this.state.refunds.filter((r) => r.account_id === accountId).map((r) => ({ ...r }));
  }

  escalationsFor(accountId: string): Escalation[] {
    return this.state.escalations.filter((e) => e.account_id === accountId).map((e) => ({ ...e }));
  }

  sessionRefundedCents(session: BillingSession): number {
    return this.state.refunds
      .filter((r) => r.session_id === session.id)
      .reduce((sum, r) => sum + r.amount_cents, 0);
  }

  searchHelpCenter(query: string): { results: HelpArticle[] } {
    const words = new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    const scored: Array<[number, HelpArticle]> = [];
    for (const article of HELP_ARTICLES) {
      const text = `${article.title} ${article.body}`.toLowerCase();
      let score = 0;
      for (const w of words) if (text.includes(w)) score += 1;
      if (score > 0) scored.push([score, article]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return { results: scored.slice(0, 2).map(([, a]) => ({ ...a })) };
  }

  // --- writes -----------------------------------------------------------------------------------

  /**
   * Issues a refund after checking every enforced policy rule. Rejections are audited too, since
   * a model repeatedly hitting a guardrail is worth a human's attention.
   */
  issueRefund(session: BillingSession, request: RefundRequest): RefundResult {
    try {
      return this.issueRefundChecked(session, request);
    } catch (err) {
      if (err instanceof BillingError) {
        this.log(session, "refund.rejected", { ...request, code: err.code, error: err.message });
      }
      throw err;
    }
  }

  escalateToHuman(session: BillingSession, accountId: string, summary: string): EscalationResult {
    this.getAccount(accountId);
    const ticket: Escalation = {
      ticket_id: `tkt_${String(this.state.escalations.length + 1).padStart(3, "0")}`,
      account_id: accountId,
      summary,
      session_id: session.id,
      created_at: this.now().toISOString(),
    };
    this.commit({ ...this.state, escalations: [...this.state.escalations, ticket] });
    this.log(session, "escalation.created", { ticket_id: ticket.ticket_id, account_id: accountId, summary });
    return { ...ticket, expected_response: "within 1 business day" };
  }

  // --- internals --------------------------------------------------------------------------------

  private issueRefundChecked(session: BillingSession, request: RefundRequest): RefundResult {
    const { account_id, invoice_id, amount_cents, reason } = request;
    const invoice = this.requireInvoice(invoice_id);
    const account = this.getAccount(account_id);

    if (invoice.account_id !== account.account_id) {
      throw new BillingError(
        "ACCOUNT_MISMATCH",
        `Invoice ${invoice_id} does not belong to account ${account_id}. Only refund invoices on the ` +
          "customer's own account; call list_invoices with their account_id to find the right one.",
      );
    }

    const blocker = this.refundBlocker(invoice, account);
    if (blocker) throw blocker;

    if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
      throw new BillingError("INVALID_AMOUNT", `amount_cents must be a positive whole number of cents, got ${amount_cents}.`);
    }
    const refunded = this.refundedCents(invoice_id);
    const remaining = invoice.amount_cents - refunded;
    if (amount_cents > remaining) {
      throw new BillingError(
        "INVALID_AMOUNT",
        `amount_cents must be between 1 and ${remaining} for invoice ${invoice_id} ` +
          `(invoice total ${formatCents(invoice.amount_cents)}, already refunded ${formatCents(refunded)}).`,
      );
    }

    const sessionSoFar = this.sessionRefundedCents(session);
    if (sessionSoFar + amount_cents > SESSION_REFUND_LIMIT_CENTS) {
      throw new BillingError(
        "SESSION_LIMIT_EXCEEDED",
        `Refunding ${formatCents(amount_cents)} would bring this session's refunds to ` +
          `${formatCents(sessionSoFar + amount_cents)}, over the ${formatCents(SESSION_REFUND_LIMIT_CENTS)} limit ` +
          `(${formatCents(sessionSoFar)} already refunded this session). Do not issue a partial refund: ` +
          "escalate to a human with escalate_to_human and tell the customer the billing team will follow up.",
      );
    }

    const refund: Refund = {
      refund_id: `rf_${String(this.state.refunds.length + 1).padStart(3, "0")}`,
      invoice_id,
      account_id,
      amount_cents,
      reason,
      session_id: session.id,
      created_at: this.now().toISOString(),
    };
    this.commit({ ...this.state, refunds: [...this.state.refunds, refund] });
    this.log(session, "refund.issued", {
      refund_id: refund.refund_id,
      account_id,
      invoice_id,
      amount_cents,
      reason,
    });

    const sessionTotal = sessionSoFar + amount_cents;
    return {
      refund: { ...refund },
      invoice: this.invoiceView(invoice),
      session_refunded_cents: sessionTotal,
      session_remaining_cents: SESSION_REFUND_LIMIT_CENTS - sessionTotal,
      message:
        `Refunded ${formatCents(amount_cents)} on invoice ${invoice_id} to the original payment method. ` +
        "It usually arrives within 5-10 business days.",
    };
  }

  /** The first enforced rule that stops this invoice being refunded at all, or null. */
  private refundBlocker(invoice: Invoice, account: Account): BillingError | null {
    if (account.chargeback_open) {
      return new BillingError(
        "CHARGEBACK_OPEN",
        `Account ${account.account_id} has an open chargeback, so no refunds can be issued on it. ` +
          "Escalate to a human with escalate_to_human and tell the customer the billing team will follow up.",
      );
    }
    if (invoice.status !== "paid") {
      return new BillingError(
        "INVOICE_NOT_PAID",
        `Invoice ${invoice.invoice_id} has status "${invoice.status}": the payment never went through, so ` +
          "the customer was not charged and there is nothing to refund. Tell them so; do not retry.",
      );
    }
    const windowStart = refundWindowStart(this.today);
    if (invoice.date < windowStart) {
      return new BillingError(
        "OUTSIDE_REFUND_WINDOW",
        `Invoice ${invoice.invoice_id} is dated ${invoice.date}. Only invoices dated on or after ${windowStart} ` +
          "(the last 30 days) can be refunded. Tell the customer it is outside the refund window; do not retry.",
      );
    }
    const remaining = invoice.amount_cents - this.refundedCents(invoice.invoice_id);
    if (remaining <= 0) {
      return new BillingError(
        "ALREADY_FULLY_REFUNDED",
        `Invoice ${invoice.invoice_id} has already been refunded in full (${formatCents(invoice.amount_cents)}). ` +
          "Nothing is left to refund.",
      );
    }
    return null;
  }

  private requireInvoice(invoiceId: string): Invoice {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      throw new BillingError(
        "INVOICE_NOT_FOUND",
        `Unknown invoice_id "${invoiceId}". Call list_invoices with the customer's account_id to see their invoices.`,
      );
    }
    return invoice;
  }

  private refundedCents(invoiceId: string): number {
    return this.state.refunds
      .filter((r) => r.invoice_id === invoiceId)
      .reduce((sum, r) => sum + r.amount_cents, 0);
  }

  private invoiceView(invoice: Invoice): InvoiceView {
    const refunded = this.refundedCents(invoice.invoice_id);
    const account = this.accounts.get(invoice.account_id);
    const blocker = account ? this.refundBlocker(invoice, account) : null;
    return {
      ...invoice,
      refunded_cents: refunded,
      refundable_cents: blocker ? 0 : invoice.amount_cents - refunded,
      refund_blocker: blocker ? blocker.code : null,
    };
  }

  /** Saves first, then swaps in-memory state, so a failed write never leaves the two out of sync. */
  private commit(next: BillingState): void {
    this.store.save(next);
    this.state = next;
  }

  private log(session: BillingSession, action: AuditEntry["action"], details: Record<string, unknown>): void {
    this.audit.write({ ts: this.now().toISOString(), session_id: session.id, action, ...details });
  }
}
