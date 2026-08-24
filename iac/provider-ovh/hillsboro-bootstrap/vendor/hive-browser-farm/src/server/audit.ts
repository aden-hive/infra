import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Append-only record of who made an account do something.
 *
 * Until now every action arrived from the agent path, where "who" was always
 * the same answer. Once an operator can send a message as any account from a
 * web panel, "who sent that, and from which session" becomes a question with a
 * real answer that nothing was recording.
 *
 * Append-only and never rotated in place: a log that can be rewritten by the
 * process it audits is decoration. Only actions that reached execution are
 * recorded — a refusal never happened, and logging it would bury the real
 * sends among the noise of a UI probing what is allowed.
 */
export interface AuditEntry {
  at: number;
  /** Staff email from the dashboard JWT, or "token" for shared-token callers. */
  actor: string;
  accountId: string;
  action: string;
  outcome: "ok" | "refused" | "failed";
  /** Action-specific: the post reacted to, the recipient messaged. */
  target?: string;
  reason?: string;
}

export class AuditLog {
  private readonly path: string;

  constructor(root: string) {
    this.path = join(root, "audit.jsonl");
  }

  async record(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // One JSON object per line, appended: concurrent writers cannot interleave
    // a partial record the way a read-modify-write of a JSON array would.
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** Most recent entries, newest first. */
  async recent(limit = 50): Promise<AuditEntry[]> {
    try {
      const lines = (await readFile(this.path, "utf8")).trim().split("\n");
      return lines
        .slice(-limit)
        .reverse()
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditEntry];
          } catch {
            // A torn final line (process killed mid-append) must not hide the
            // rest of the history.
            return [];
          }
        });
    } catch {
      return [];
    }
  }
}
