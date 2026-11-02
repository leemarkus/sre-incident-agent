/**
 * Two honesty rules, both written into every report footer:
 *  - `total_cost_usd` is a CLIENT-SIDE ESTIMATE (Claude Code's docs say so). The
 *    ledger is a control, not an invoice.
 *  - A refused run is a ledger entry too (`costUsd: 0`, `outcome: "refused"`),
 *    so "the agent went quiet" is always distinguishable from "nothing fired".
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type LedgerOutcome = "completed" | "rejected-safety" | "refused-budget" | "refused-auth" | "refused-limit" | "failed";

export type LedgerEntry = {
  at: string;
  /** `YYYY-MM`, derived from `at` in UTC so a month boundary is one line, not a timezone. */
  month: string;
  kind: "triage" | "postmortem";
  alert: string;
  outcome: LedgerOutcome;
  costUsd: number;
  model: string;
  numTurns: number;
  durationMs: number;
  reportPath?: string;
  sessionId?: string;
  note?: string;
};

export const WARN_FRACTION = 0.8;

export type BudgetState = "ok" | "warn" | "exhausted";

export type BudgetVerdict = {
  state: BudgetState;
  spentUsd: number;
  budgetUsd: number;
  fraction: number;
  remainingUsd: number;
};

export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function ledgerPath(stateDir: string): string {
  return path.join(stateDir, "sub-ledger.jsonl");
}

/**
 * Read the ledger, tolerating damage. A truncated last line —
 * the shape a crash mid-append leaves — used to throw out of `JSON.parse` and
 * brick every future read, which would take the budget gate down with it. A
 * malformed line is a diagnosed recovery case: skipped, counted, and reported
 * on stderr so it is visible rather than silent.
 */
export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return [];
  const entries: LedgerEntry[] = [];
  let malformed = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      malformed += 1;
    }
  }
  if (malformed > 0) {
    process.stderr.write(
      `sre-agent ledger: skipped ${malformed} malformed line(s) in ${file}. Month-to-date spend is ` +
        "understated by whatever they recorded; the file is append-only, so repair it by hand rather " +
        "than deleting it.\n",
    );
  }
  return entries;
}

export function appendLedger(file: string, entry: LedgerEntry): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

export function monthSpend(entries: readonly LedgerEntry[], month: string): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.month === month && Number.isFinite(entry.costUsd)) total += entry.costUsd;
  }
  return total;
}

/**
 * The gate. `exhausted` at ≥ 100 % of the monthly ceiling, `warn` at ≥ 80 %.
 * A run that would START inside budget is allowed even if it might end over it;
 * the per-run `--max-budget-usd` bounds the overshoot to one run's ceiling.
 */
export function budgetVerdict(spentUsd: number, budgetUsd: number): BudgetVerdict {
  const fraction = budgetUsd > 0 ? spentUsd / budgetUsd : Number.POSITIVE_INFINITY;
  const state: BudgetState =
    fraction >= 1 ? "exhausted" : fraction >= WARN_FRACTION ? "warn" : "ok";
  return {
    state,
    spentUsd,
    budgetUsd,
    fraction,
    remainingUsd: Math.max(0, budgetUsd - spentUsd),
  };
}

export function describeBudget(verdict: BudgetVerdict): string {
  const pct = Number.isFinite(verdict.fraction) ? `${Math.round(verdict.fraction * 100)} %` : "n/a";
  return (
    `$${verdict.spentUsd.toFixed(2)} of $${verdict.budgetUsd.toFixed(2)} this month (${pct}, ` +
    `${verdict.state.toUpperCase()}). Client-side estimates from \`total_cost_usd\`. On plan limits this is a ` +
    "proxy for window consumption, not a bill; the subscription's own 5-hour/weekly limit is the enforcement of last resort."
  );
}

// ---------------------------------------------------------------------------
// The run lock

/**
 * One run at a time. The gate reads the ledger, then the run
 * spends, then the run appends — with nothing serialising the three, two
 * concurrent runs (the poller and a manual `tools/sub-triage`, say) both passed
 * the same pre-run balance and both spent. The lock is held from the budget gate
 * through settlement, so a second run sees "taken" rather than a stale balance.
 *
 * `mkdir` is the primitive: atomic on every filesystem this runs on, needs no
 * dependency, and leaves a directory a human can delete. A lock older than one
 * wall-clock ceiling plus a minute is stale by construction — the holder cannot
 * still be running — and is broken automatically.
 */
export const LOCK_STALE_GRACE_MS = 60_000;

export function runLockPath(stateDir: string): string {
  return path.join(stateDir, "sub-run.lock");
}

export type RunLock = { path: string; release: () => void };

export function acquireRunLock(stateDir: string, staleAfterMs: number, now: Date = new Date()): RunLock | undefined {
  const dir = runLockPath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const take = (): boolean => {
    try {
      mkdirSync(dir);
      return true;
    } catch {
      return false;
    }
  };
  let held = take();
  if (!held) {
    let age = Number.POSITIVE_INFINITY;
    try {
      age = now.getTime() - statSync(dir).mtimeMs;
    } catch {
      /* vanished between the failed mkdir and the stat: treat as stale */
    }
    if (age < staleAfterMs) return undefined;
    process.stderr.write(`sre-agent: breaking a stale run lock at ${dir} (age ${Math.round(age / 1000)} s)\n`);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      return undefined;
    }
    held = take();
    if (!held) return undefined;
  }
  try {
    writeFileSync(path.join(dir, "holder.json"), JSON.stringify({ pid: process.pid, at: now.toISOString() }), "utf8");
  } catch {
    /* the directory is the lock; the note inside it is a convenience */
  }
  let released = false;
  return {
    path: dir,
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* nothing useful to do: the staleness rule will clear it */
      }
    },
  };
}
