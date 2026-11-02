/**
 * `tools/sub-file-issue <report.md> [--key K] [--live]`: file one published
 * report by hand. Dry unless `--live`. The group key comes from the
 * poll state (the group whose `lastReport` is this report) unless `--key` is
 * given. A live filing records the issue on that state entry when there is one;
 * should a concurrent poll overwrite it, the next filing still finds the open
 * issue by its title, so nothing is filed twice.
 */

import path from "node:path";

import { ledgerPath, readLedger } from "./budget.js";
import { loadSubscriptionConfig } from "./config.js";
import { fileIssue, issueRecordFrom, IssueError } from "./issues.js";
import { readState, statePath, writeState } from "./poll.js";
import { EXIT_CONFIG, EXIT_OK, PROJECT_ROOT } from "./run.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const keyIndex = argv.indexOf("--key");
  const keyArg = keyIndex >= 0 ? argv[keyIndex + 1] : undefined;
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--key");
  const report = positional[0];
  if (report === undefined) {
    process.stderr.write("usage: tools/sub-file-issue <report.md> [--key 'alertname|namespace|subject'] [--live]\n");
    process.exitCode = EXIT_CONFIG;
    return;
  }
  const reportPath = path.resolve(report);
  let sub: ReturnType<typeof loadSubscriptionConfig>["sub"];
  try {
    ({ sub } = loadSubscriptionConfig(process.env));
  } catch (error) {
    process.stderr.write(`sub-file-issue: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT_CONFIG;
    return;
  }
  const stateFile = statePath(sub.SRE_SUB_STATE_DIR);
  const state = readState(stateFile);
  const fromState = Object.entries(state.groups).find(([, g]) => g.lastReport === reportPath)?.[0];
  const key = keyArg ?? fromState;
  if (key === undefined) {
    process.stderr.write(`sub-file-issue: no poll-state group has lastReport ${reportPath}; pass --key 'alertname|namespace|subject'\n`);
    process.exitCode = EXIT_CONFIG;
    return;
  }
  const previous = state.groups[key]?.issue;
  const now = new Date();
  try {
    const result = await fileIssue({
      mode: live ? "live" : "dry",
      key,
      reportPath,
      ...(previous === undefined ? {} : { previous }),
      ledger: readLedger(ledgerPath(sub.SRE_SUB_STATE_DIR)),
      root: PROJECT_ROOT,
      lockDir: sub.SRE_SUB_STATE_DIR,
      now,
    });
    if (live) {
      const fresh = readState(stateFile);
      const entry = fresh.groups[key];
      const record = issueRecordFrom(result, previous, now);
      if (entry !== undefined && record !== undefined) {
        entry.issue = record;
        writeState(stateFile, fresh);
      }
    }
    const { body, ...summary } = result;
    process.stdout.write(`${JSON.stringify({ key, ...summary }, null, 2)}\n`);
    if (body !== undefined) process.stdout.write(`\n----- issue body (${body.length} chars) -----\n${body}\n`);
    process.exitCode = EXIT_OK;
  } catch (error) {
    process.stderr.write(`sub-file-issue: ${error instanceof IssueError || error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
