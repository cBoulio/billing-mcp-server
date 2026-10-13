import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * Mutable billing state. Accounts, invoices, and help articles are fixed seed data; only refunds
 * and escalations change, so only they are stored.
 */
export const RefundSchema = z.object({
  refund_id: z.string(),
  invoice_id: z.string(),
  account_id: z.string(),
  amount_cents: z.number().int(),
  reason: z.string(),
  session_id: z.string(),
  created_at: z.string(),
});

export const EscalationSchema = z.object({
  ticket_id: z.string(),
  account_id: z.string(),
  summary: z.string(),
  session_id: z.string(),
  created_at: z.string(),
});

export const BillingStateSchema = z.object({
  version: z.literal(1),
  refunds: z.array(RefundSchema),
  escalations: z.array(EscalationSchema),
});

export type Refund = z.infer<typeof RefundSchema>;
export type Escalation = z.infer<typeof EscalationSchema>;
export type BillingState = z.infer<typeof BillingStateSchema>;

export function emptyState(): BillingState {
  return { version: 1, refunds: [], escalations: [] };
}

export interface StateStore {
  /** Human-readable description of where state lives, for startup logs. */
  readonly description: string;
  load(): BillingState;
  save(state: BillingState): void;
}

/** Default store: state lives for the life of the process. */
export class MemoryStore implements StateStore {
  readonly description = "in-memory (state is lost when the server stops)";
  private state: BillingState;

  constructor(initial: BillingState = emptyState()) {
    this.state = structuredClone(initial);
  }

  load(): BillingState {
    return structuredClone(this.state);
  }

  save(state: BillingState): void {
    this.state = structuredClone(state);
  }
}

/**
 * Stores state in a JSON file so refunds and tickets survive restarts. Writes go to a temp file
 * first and are renamed into place, so a crash mid-write never leaves a half-written file.
 */
export class JsonFileStore implements StateStore {
  readonly path: string;
  readonly description: string;

  constructor(path: string, options: { reset?: boolean } = {}) {
    this.path = resolve(path);
    this.description = `JSON file ${this.path}`;
    if (options.reset || !existsSync(this.path)) {
      this.save(emptyState());
    }
  }

  load(): BillingState {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new Error(
        `Could not read state file ${this.path}: ${(err as Error).message}. ` +
          "Fix or delete the file, or start with --reset.",
      );
    }
    const parsed = BillingStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `State file ${this.path} is not valid billing state: ${parsed.error.message}. ` +
          "Fix or delete the file, or start with --reset.",
      );
    }
    return parsed.data;
  }

  save(state: BillingState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }
}
