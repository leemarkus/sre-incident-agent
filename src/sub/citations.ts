/** sub-only citation contract and offline, transcript-bound counts. */
import { docsInResult, parseCitations, stripFences, unquotedCitationTokens, namedDocPaths, type RetrievalCall } from "../citations.js";

export const SUB_CITATION_CONTRACT = `Documentation contract (subscription mode): Every factual claim about a component's behavior must carry a citation. Write each as one line beginning "Claim:" (optional list bullet), followed by the claim and its citation: \`repo:docs/path.md@sha\` — "exact span". Call docs_read first and copy a 6–600 character span from its returned document text, with the exact repo, doc path and SHA returned. A docs_search hit alone is not a citation. Keep the quote on the claim's line. If no document supports a claim, end that Claim: line with "uncited"; never invent a citation. This requirement also applies when documentation tools are unavailable.`;

const whitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Counts, not the legacy grade.ts pass/fail checks. No semantic entailment claim. */
export function measureSubCitations(report: string, calls: readonly RetrievalCall[]) {
  const docs = calls.filter((call) => call.tool === "docs_read").flatMap(docsInResult);
  const prose = stripFences(report).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const valid = (citation: ReturnType<typeof parseCitations>[number]): boolean => {
    const quote = whitespace(citation.quote);
    return quote.length >= 6 && docs.some((doc) => doc.repo === citation.repo && doc.path === citation.path &&
      doc.ref === citation.ref && whitespace(doc.text).includes(quote));
  };
  const citations = parseCitations(prose, []);
  const claims = prose.split(/\r?\n/).filter((line) => /^\s*(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)?(?:Claim:|\*\*Claim:\*\*|__Claim:__)\s+\S/.test(line));
  const bareReferences = (text: string): number => {
    const withoutQuotes = text.replace(/`[^`]+`\s*(?:[—–-]|:)\s*["“][^"”]*["”]/g,
      (span) => parseCitations(span, []).length > 0 ? "" : span);
    const tokens = unquotedCitationTokens(withoutQuotes);
    const tokenPaths = new Set(tokens.map((token) => token.slice(token.indexOf(":") + 1, token.lastIndexOf("@"))));
    return tokens.length + namedDocPaths(withoutQuotes).filter((path) => !tokenPaths.has(path)).length;
  };
  return {
    "sub-citations.cited-claims": claims.filter((line) => {
      const cs = parseCitations(line, []);
      return !/\buncited\s*[.!]?\s*$/.test(line) && cs.length > 0 &&
        cs.every(valid) && bareReferences(line) === 0;
    }).length,
    "sub-citations.verified-quotes": citations.filter(valid).length,
    claims: claims.length,
    unverified: citations.filter((citation) => !valid(citation)).length + bareReferences(prose),
    docs_read: calls.filter((call) => call.tool === "docs_read").length,
    docs_search: calls.filter((call) => call.tool === "docs_search").length,
  };
}
