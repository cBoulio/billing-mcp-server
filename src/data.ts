/**
 * Seed data for Larkspur Cloud, a fictional SaaS company.
 *
 * Ported from the support-agent-evals world (src/support_evals/world.py) with the same ids and
 * values, so an agent evaluated there sees the same customers and invoices here.
 */

export const TODAY = "2026-10-01";
export const REFUND_WINDOW_DAYS = 30;
export const SESSION_REFUND_LIMIT_CENTS = 20_000;

export type InvoiceStatus = "paid" | "failed";

export interface Account {
  account_id: string;
  name: string;
  email: string;
  plan: string;
  chargeback_open: boolean;
}

export interface Invoice {
  invoice_id: string;
  account_id: string;
  date: string;
  description: string;
  amount_cents: number;
  status: InvoiceStatus;
}

export interface HelpArticle {
  id: string;
  title: string;
  body: string;
}

function account(
  account_id: string,
  name: string,
  email: string,
  plan: string,
  chargeback_open = false,
): Account {
  return { account_id, name, email, plan, chargeback_open };
}

function invoice(
  invoice_id: string,
  account_id: string,
  date: string,
  description: string,
  amount_cents: number,
  status: InvoiceStatus = "paid",
): Invoice {
  return { invoice_id, account_id, date, description, amount_cents, status };
}

export const ACCOUNTS: readonly Account[] = [
  account("acct_1001", "Dana Whitfield", "dana.whitfield@example.com", "Team (monthly, $49)"),
  account("acct_1002", "Marco Ruiz", "marco.ruiz@example.com", "Business (annual, $1,188)"),
  account("acct_1003", "Priya Natarajan", "priya.n@example.com", "Starter (monthly, $19)"),
  account("acct_1004", "Sam Okafor", "sam.okafor@example.com", "Pro (monthly, $99)", true),
  account("acct_1005", "Lee Chen", "lee.chen@example.com", "Pro (monthly, $79)"),
  account("acct_1006", "Jo Martin", "jo.martin@example.com", "Team (monthly, $49)"),
  account("acct_1007", "Ava Kowalski", "ava.kowalski@example.com", "Business (monthly, $149)"),
];

export const INVOICES: readonly Invoice[] = [
  invoice("inv_4901", "acct_1001", "2026-08-15", "Team plan, Aug 15 - Sep 14", 4900),
  invoice("inv_5001", "acct_1001", "2026-09-15", "Team plan, Sep 15 - Oct 14", 4900),
  invoice("inv_5002", "acct_1001", "2026-09-15", "Team plan, Sep 15 - Oct 14", 4900),
  invoice("inv_5101", "acct_1002", "2026-09-20", "Business plan, annual, Sep 20 2026 - Sep 19 2027", 118800),
  invoice("inv_5201", "acct_1003", "2026-07-02", "Starter plan, Jul 2 - Aug 1", 1900),
  invoice("inv_5202", "acct_1003", "2026-08-02", "Starter plan, Aug 2 - Sep 1", 1900),
  invoice("inv_5203", "acct_1003", "2026-09-02", "Starter plan, Sep 2 - Oct 1", 1900),
  invoice("inv_5301", "acct_1004", "2026-09-25", "Pro plan, Sep 25 - Oct 24", 9900),
  invoice("inv_5401", "acct_1005", "2026-09-10", "Pro plan, Sep 10 - Oct 9", 7900),
  invoice("inv_5402", "acct_1005", "2026-09-28", "Add-on: 5 extra seats, Sep 28 - Oct 9", 3500),
  invoice("inv_5500", "acct_1006", "2026-08-31", "Team plan, Aug 31 - Sep 29", 4900),
  invoice("inv_5501", "acct_1006", "2026-09-30", "Team plan, Sep 30 - Oct 29", 4900, "failed"),
  invoice("inv_5601", "acct_1007", "2026-09-12", "Business plan, Sep 12 - Oct 11", 14900),
  invoice("inv_5602", "acct_1007", "2026-09-12", "Add-on: priority support, Sep 12 - Oct 11", 7900),
];

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: "kb-01",
    title: "Download invoices as PDF",
    body:
      "Go to Settings > Billing > Invoices and choose Download PDF next to any invoice. " +
      "Account admins can export every invoice as one ZIP file from the same page.",
  },
  {
    id: "kb-02",
    title: "Change or cancel your plan",
    body:
      "Admins can change or cancel the plan under Settings > Billing > Plan. " +
      "Cancelling stops future charges; it does not refund past invoices.",
  },
  {
    id: "kb-03",
    title: "Refunds",
    body:
      "Paid invoices can be refunded within 30 days of the invoice date. " +
      "Refunds return to the original payment method within 5-10 business days.",
  },
  {
    id: "kb-04",
    title: "Failed payments",
    body:
      "If a payment fails, the card is not charged. We retry automatically after 3 days " +
      "and email the account admin.",
  },
];
