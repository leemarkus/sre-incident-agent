import { namespacesInPayload, type WebhookPayload } from "./alert.js";

const namespaceName = (value: string): boolean =>
  value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);

export type SweepNamespaces = { namespaces: string[]; note?: string };

/**
 * Read literal namespace matchers from a deliberately small PromQL subset:
 * selectors, numbers, parentheses, comparisons, arithmetic, and one-argument
 * absent/sum/count/min/max functions. Unsupported syntax is unresolved, never
 * partly parsed. No URL is fetched and neither regex nor negative matchers can
 * choose a namespace. Strings in other label values cannot masquerade as code.
 */
function expressionNamespaces(expr: string): string[] | undefined {
  const tokens = expr.match(/\s+|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|[a-zA-Z_:][a-zA-Z0-9_:]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|=~|!~|!=|==|>=|<=|[{}(),+*/%^<>=-]/g) ?? [];
  if (tokens.join("") !== expr) return undefined;
  const input = tokens.filter((t) => !/^\s|^#/.test(t));
  // The RHS of unless excludes series; it cannot establish the subject's namespace.
  // Refuse the entire expression rather than partially interpreting set semantics.
  if (input.includes("unless")) return undefined;
  const candidates: string[] = [];
  let i = 0;
  const take = (token: string): boolean => {
    if (input[i] !== token) return false;
    i += 1;
    return true;
  };
  const selector = (): boolean => {
    if (!take("{")) return false;
    if (take("}")) return true;
    do {
      const key = input[i++];
      const op = input[i++];
      const value = input[i++];
      if (!key || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ||
          !op || !["=", "!=", "=~", "!~"].includes(op) ||
          !value || !/^["'`]/.test(value)) return false;
      if (key === "namespace" || key === "exported_namespace") {
        const literal = value.slice(1, -1);
        if (op !== "=" || !namespaceName(literal)) return false;
        candidates.push(literal);
      }
      if (take("}")) return true;
      if (!take(",")) return false;
    } while (input[i] !== undefined && input[i] !== "}");
    return take("}");
  };
  const primary = (): boolean => {
    if (take("+") || take("-")) return primary();
    if (take("(")) return expression() && take(")");
    if (input[i] === "{") return selector();
    const token = input[i++];
    if (!token) return false;
    if (/^(?:\d|\.\d)/.test(token)) return true;
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(token)) return false;
    if (take("(")) {
      return ["absent", "sum", "count", "min", "max"].includes(token) &&
        expression() && take(")");
    }
    return input[i] !== "{" || selector();
  };
  const expression = (): boolean => {
    if (!primary()) return false;
    while (input[i] && /^(?:==|!=|>=|<=|>|<|\+|-|\*|\/|%|\^|and|or|unless)$/.test(input[i]!)) {
      i += 1;
      if (!primary()) return false;
    }
    return true;
  };
  return expression() && i === input.length ? candidates : undefined;
}

/** Explicit grouped namespaces retain their established multi-namespace behavior. */
export function resolveSweepNamespaces(payload: WebhookPayload, metricAbsence: boolean): SweepNamespaces {
  const unresolved = (why: string): SweepNamespaces => ({
    namespaces: [],
    note: `Namespace unresolvable: ${why}. No namespaced reads were planned; the agent remains namespaced-only (F2). Do not guess a namespace.`,
  });
  // Preserve the old order, filtering and schema-level skips for explicit labels.
  const explicit = namespacesInPayload(payload);
  if (explicit.length > 0) return { namespaces: explicit };

  const inferred = new Set<string>();
  let unsupportedExpression = false;
  for (const alert of payload.alerts) {
    if (!alert.generatorURL) continue;
    try {
      // WHATWG URL tolerates bad %-escapes; inference must not.
      if (/%(?![0-9a-f]{2})/i.test(alert.generatorURL)) return unresolved("malformed generatorURL encoding");
      const url = new URL(alert.generatorURL);
      if (!["http:", "https:"].includes(url.protocol)) return unresolved("unsupported generatorURL protocol");
      const expressions = [...url.searchParams].filter(([key]) => /^(?:g\d+\.)?expr$/.test(key));
      for (const [, expr] of expressions) {
        const values = expressionNamespaces(expr);
        if (values === undefined) {
          unsupportedExpression = true;
          continue;
        }
        for (const value of values) inferred.add(value);
      }
    } catch {
      return unresolved("malformed generatorURL");
    }
  }
  if (inferred.size > 1) return unresolved("generatorURL expressions name several namespaces (ambiguous)");
  if (!unsupportedExpression && inferred.size === 1) return {
    namespaces: [...inferred], note: "Namespace inferred from an exact namespace matcher in generatorURL expr (URL not fetched).",
  };

  // A Prometheus external label identifies the monitoring source, not the
  // alert subject. Reading its namespace is useful only for metric absence.
  if (metricAbsence) {
    const sources = new Set<string>();
    for (const labels of [payload.groupLabels, payload.commonLabels, ...payload.alerts.map((a) => a.labels)]) {
      const prometheus = labels["prometheus"];
      if (prometheus === undefined) continue;
      const parts = prometheus.split("/");
      if (parts.length !== 2 || !namespaceName(parts[0]!) ||
          !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(parts[1]!)) {
        return unresolved("malformed prometheus namespace/name label");
      }
      sources.add(parts[0]!);
    }
    if (sources.size > 1) return unresolved("prometheus labels name several source namespaces (ambiguous)");
    if (sources.size === 1) return {
      namespaces: [...sources],
      note: "Namespace inferred from the prometheus namespace/name label: reads cover the MONITORING SOURCE, not the alert subject; the subject namespace remains unresolvable.",
    };
  }
  return unresolved(unsupportedExpression
    ? "malformed or unsupported generatorURL expression"
    : "no explicit namespace label or unique literal namespace in generatorURL expr");
}
