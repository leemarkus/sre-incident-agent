/**
 * Issue filing's destination is operator configuration, validated before use.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { issueTargetFromEnv, issueUrl } from "../src/sub/issues.js";

const good = {
  SRE_SUB_ISSUE_URL: "https://git.example.com",
  SRE_SUB_ISSUE_REPO: "platform/incidents",
  SRE_SUB_ISSUE_BOT: "incident-bot",
  SRE_SUB_ISSUE_TOKEN_REF: "op://vault/item/credential",
  SRE_SUB_ISSUE_KEYCHAIN_ITEM: "sre-agent-op-sa",
};

describe("issue filing destination", () => {
  it("a complete configuration resolves to the configured target", () => {
    const target = issueTargetFromEnv(good);
    assert.equal(target.url, "https://git.example.com");
    assert.equal(issueUrl(target, 7), "https://git.example.com/platform/incidents/issues/7");
  });

  it("there are no defaults: every variable is required", () => {
    for (const key of Object.keys(good)) {
      const env: Record<string, string> = { ...good };
      delete env[key];
      assert.throws(() => issueTargetFromEnv(env), new RegExp(key));
    }
  });

  it("the destination must be a bare https origin and an owner/name repository", () => {
    for (const url of ["http://git.example.com", "https://user:pw@git.example.com", "https://git.example.com/api", "https://git.example.com?x=1", "not a url"]) {
      assert.throws(() => issueTargetFromEnv({ ...good, SRE_SUB_ISSUE_URL: url }), url);
    }
    for (const repo of ["incidents", "a/b/c", "../x", "a/..", "a /b"]) {
      assert.throws(() => issueTargetFromEnv({ ...good, SRE_SUB_ISSUE_REPO: repo }), repo);
    }
  });

  it("the token reference must be an op:// secret reference", () => {
    for (const ref of ["vault/item/credential", "op://vault/item", "op://vault/item/field extra"]) {
      assert.throws(() => issueTargetFromEnv({ ...good, SRE_SUB_ISSUE_TOKEN_REF: ref }), ref);
    }
  });
});
