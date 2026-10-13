import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Audit log of every mutating action (and every rejected attempt at one), as JSON lines.
 *
 * On a stdio MCP server, stdout carries the JSON-RPC stream, so nothing here ever writes to it.
 * The default sink is stderr, which Claude Desktop and Claude Code capture in their MCP logs.
 */
export interface AuditEntry {
  ts: string;
  session_id: string;
  action: "refund.issued" | "refund.rejected" | "escalation.created" | "state.reset";
  [detail: string]: unknown;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

export class StderrAuditSink implements AuditSink {
  write(entry: AuditEntry): void {
    process.stderr.write(`[audit] ${JSON.stringify(entry)}\n`);
  }
}

export class FileAuditSink implements AuditSink {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  write(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

/** Keeps entries in memory. Used by tests. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];

  write(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
