import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

/**
 * The agent's egress boundary.
 *
 * ## The rule, and why it is this rule
 *
 * **A host is local iff every IP address the connection actually uses is in the
 * local set.** Not "iff it is spelled a certain way".
 *
 *  - An **address literal** is decided at config load. Nothing can change what
 *    `172.16.0.10` means between the check and the connection.
 *  - A **name** is decided at connect time, inside the socket's own `lookup`
 *    hook, and the address that is validated is the address the socket then
 *    connects to. That is what makes this honest rather than racy:
 *    rejected DNS resolution because a `dns.lookup()` at config load can be
 *    answered differently at connect time (textbook rebinding). Validating
 *    *inside* the lookup the connection performs closes that window by
 *    construction — there is no second resolution to disagree with.
 *
 * ## Where enforcement applies
 *
 *  - **Local mode** — `ANTHROPIC_TRIAGE_MODEL === LOCAL_MODEL_NAME` with a
 *    `LOCAL_MODEL_BASE_URL` set: every constrained URL is enforced, at load for
 *    literals and at connect for names, and every tool's HTTP client is
 *    `localFetch`.
 *  - **API mode** — enforcement is off, and `describeEgress()` says so in the
 *    transcript and in the report's own metering footer. Explicit and recorded,
 *    never implicit: the claim in the artefact matches what the code did.
 */

/** Thrown when an address or URL fails the locality rule. */
export class EgressError extends Error {}

/**
 * Every config variable naming a host this process may open a connection to.
 *
 * `PROMETHEUS_URL` is included even though the brief named four. It is the same
 * class of outbound path by construction, and leaving it out would have
 * recreated the exact hole this file exists to close.
 */
export const EGRESS_URL_VARS = [
  "LOCAL_MODEL_BASE_URL",
  "PROMETHEUS_URL",
  "GRAFANA_URL",
  "ARGOCD_URL",
  "FORGEJO_URL",
] as const;

export type EgressUrlVar = (typeof EGRESS_URL_VARS)[number];

// ---------------------------------------------------------------------------
// The address predicate — the one place "local" is defined

/**
 * Is a **literal IPv4 address** in the local set?
 *
 * `undefined` means "not an IPv4 literal at all", which the callers distinguish
 * from `false` ("an IPv4 literal, and it is public").
 */
export function ipv4IsLocal(host: string): boolean | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return undefined;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918

  if (a === 100 && b >= 64 && b <= 127) return true;
  // 169.254.0.0/16 is deliberately NOT allowed. It is link-local, so it reads
  // as "LAN" at a glance, but it also contains 169.254.169.254 — the cloud
  // instance-metadata address. A config var that can be pointed at a metadata
  // service is a credential-exfiltration primitive, and no local inference
  // server has ever listened there.
  return false;
}

/**
 * Is a literal IP address (v4, v6, or v4-mapped v6) in the local set?
 *
 * This is the predicate the socket's `lookup` hook applies to the address it is
 * about to hand the kernel, so it must take a bare address with no brackets.
 */
export function addressIsLocal(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  // A scope id (`fe80::1%en0`) is not part of the address.
  const bare = host.split("%")[0] ?? host;
  const v4 = ipv4IsLocal(bare);
  if (v4 !== undefined) return v4;
  if (bare === "::1") return true; // loopback
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped?.[1] !== undefined) return ipv4IsLocal(mapped[1]) === true;
  // The same address in hex: `::ffff:7f00:1` is 127.0.0.1 and `::ffff:ac10:a`
  // is 172.16.0.10. WHATWG `URL` does NOT fold these to the dotted form, so
  // the dotted branch above missed them and they fell through to "public" — a
  // refusal, so nothing was ever at risk, but a *wrong* refusal of a legitimate
  // loopback endpoint. Found by an adversarial test pass.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hexMapped?.[1] !== undefined && hexMapped[2] !== undefined) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return (
      ipv4IsLocal(
        `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`,
      ) === true
    );
  }
  // fc00::/7 unique-local. fe80::/10 link-local is excluded for the same reason
  // as 169.254/16 above.
  if (/^f[cd][0-9a-f]{0,2}:/.test(bare)) return true;
  return false;
}

/** Does this hostname denote an IP address rather than a name? */
export function hostIsAddressLiteral(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return true;
  return bare.includes(":");
}

export type HostClass =
  /** A literal address in the local set. Decided here, permanently. */
  | "local-address"
  /** A literal address outside the local set. Refused here, permanently. */
  | "public-address"
  /** A name. Undecidable here; decided inside the connection's own lookup. */
  | "name";

export function classifyHost(hostname: string): HostClass {
  if (!hostIsAddressLiteral(hostname)) return "name";
  return addressIsLocal(hostname) ? "local-address" : "public-address";
}

// ---------------------------------------------------------------------------
// URL validation at config load

export type EgressUrlCheck = {
  url: URL;
  hostClass: HostClass;
};

/**
 * Validate one egress URL's *shape and literal address*, and classify its host.
 *
 * What this can decide: the scheme, embedded credentials, and any host that is
 * an address literal. What it deliberately cannot decide: a name — which is
 * settled at connect time by {@link localOnlyLookup} instead of guessed at
 * here. See the file header for why that split is the honest one.
 */
export function checkEgressUrl(raw: string, varName: string): EgressUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError(`${varName} is not a parseable URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressError(
      `${varName} must be http: or https:, got ${url.protocol} — this is an HTTP endpoint, ` +
        "and a file:/data: URL here is either a mistake or an attempt to make the client read " +
        "something that is not a server",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new EgressError(
      `${varName} must not embed credentials. Userinfo in a URL is a classic way to make the ` +
        "real host hard to read at a glance",
    );
  }
  // `URL` normalises the exotic IPv4 spellings for us — 2130706433,
  // 0x7f.0.0.1 and 0177.0.0.1 all arrive here as "127.0.0.1" — so the range
  // check sees a canonical form and the obfuscation class is closed without
  // enumerating it.
  const hostClass = classifyHost(url.hostname);
  if (hostClass === "public-address") {
    throw new EgressError(
      `${varName} names ${url.hostname}, which is a public IP address. This process sends the ` +
        "investigation — system prompt, alert payload, verbatim cluster output, private " +
        "runbook text, and every model-chosen query string — to the hosts these variables " +
        "name, so under local-engine mode they are restricted to loopback, RFC 1918, CGNAT " +
        "(100.64.0.0/10), ::1 and fc00::/7. 169.254.0.0/16 is excluded because it contains " +
        "the cloud metadata service. A name is allowed only because it is re-checked against " +
        "the address actually connected to; an address literal has no such second chance.",
    );
  }
  return { url, hostClass };
}

/**
 * Is this URL local **on its own evidence**, with no connection to appeal to?
 *
 * The strict predicate: an address literal in the local set, and nothing else.
 *
 * ## Why this exists alongside `checkEgressUrl`
 *
 * The two are used at different moments and a name means different things at
 * each. Before a connection, a name is *undecided* and gets settled by
 * `localOnlyLookup` on the address the socket reaches. But `assertNoRedirect`
 * inspects `response.url` **after** a transfer, where there is no lookup left to
 * hook and no way to learn where the bytes came from — and it fires only when
 * something already went wrong (a hop happened despite `redirect: "manual"`).
 *
 * Admitting a name there would have been the exact mistake this change is
 * fixing, one layer down: `https://api.openai.com/v1` would have passed the
 * tripwire because it is "a name, to be checked at connect time" when the
 * connect time has already been and gone.
 *
 * ## The polarity rule
 *
 * **This predicate folds "undecidable" into `false`, so it is only sound where
 * `false` means REFUSE.** `assertNoRedirect` is such a place: an unresolvable
 * verdict there is a refusal, which is the safe direction.
 */
export function isProvablyLocalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  return classifyHost(url.hostname) === "local-address";
}

/**
 * Back-compatible name for the local-model endpoint check.
 */
export function assertLocalModelUrl(raw: string): URL {
  return checkEgressUrl(raw, "LOCAL_MODEL_BASE_URL").url;
}

// ---------------------------------------------------------------------------
// The connect-time half

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A `net.connect` lookup hook that refuses to hand the kernel a non-local
 * address.
 *
 * All addresses are required to be local, not merely the first: a name that
 * resolves to `[172.16.0.5, 203.0.113.9]` is a name whose owner can steer the
 * connection either way, and Happy Eyeballs may well pick the second.
 */
export function localOnlyLookup(
  hostname: string,
  options: unknown,
  callback: LookupCallback,
): void {
  const opts = (typeof options === "object" && options !== null ? options : {}) as Record<
    string,
    unknown
  >;
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err !== null) {
      callback(err);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0) {
      callback(
        Object.assign(new EgressError(`${hostname} resolved to no addresses`), {
          code: "ENOTFOUND",
        }) as NodeJS.ErrnoException,
      );
      return;
    }
    const offending = list.filter((a) => !addressIsLocal(a.address));
    if (offending.length > 0) {
      callback(
        Object.assign(
          new EgressError(
            `refusing to connect to ${hostname}: it resolves to ` +
              `${list.map((a) => a.address).join(", ")}, and ` +
              `${offending.map((a) => a.address).join(", ")} ${
                offending.length === 1 ? "is" : "are"
              } not a local address. Under local-engine mode this process may only open ` +
              "connections to loopback, RFC 1918, CGNAT (100.64.0.0/10), ::1 and fc00::/7, " +
              "because the request it is about to write carries investigation content. " +
              "Nothing was sent: a name is resolved before the socket is written to, and " +
              "this check runs inside that resolution. Spelling is not evidence — " +
              "*.local, *.ts.net and localhost are all subject to this same check.",
          ),
          { code: "EEGRESSDENIED" },
        ) as unknown as NodeJS.ErrnoException,
      );
      return;
    }
    if (opts["all"] === true) {
      callback(null, list);
      return;
    }
    const first = list[0] as { address: string; family: number };
    callback(null, first.address, first.family);
  });
}

/**
 * A `fetch`-shaped client that can only reach local addresses.
 *
 * Built on `node:http`/`node:https` rather than the global `fetch` for one
 * reason: the global `fetch` gives no hook to inspect or constrain the address
 * a connection lands on, which is the entire finding. An `Agent` with a
 * `lookup` does, and TLS/SNI/`Host` all stay correct because the name is still
 * the name — only the address is pinned to the one that was validated.
 *
 * Deliberately narrow. It supports what this repo's four call sites use: a
 * method, headers, a string body, an `AbortSignal`, and a streamed response
 * body. It does **not** follow redirects, which makes it equivalent to
 * `redirect: "manual"` and preserves's finding-1 fix by
 * construction rather than by remembering to pass a flag.
 */
export async function localFetch(
  input: string | URL,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const target = typeof input === "string" ? new URL(input) : input;
  // An address literal gets its verdict here; a name gets it in the lookup.
  if (classifyHost(target.hostname) === "public-address") {
    throw new EgressError(
      `refusing to connect to ${target.hostname}: it is a public IP address and this process ` +
        "is in local-engine mode, where every outbound connection must land on a local address.",
    );
  }
  const isHttps = target.protocol === "https:";
  const mod = isHttps ? https : http;
  const agent = new mod.Agent({ keepAlive: false, lookup: localOnlyLookup as never });

  return await new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port === "" ? (isHttps ? 443 : 80) : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: (init.method ?? "GET").toUpperCase(),
        headers: init.headers ?? {},
        agent,
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
        }
        const status = res.statusCode ?? 502;
        // 204/304 may not carry a body in the `Response` constructor.
        const bodyless = status === 204 || status === 304 || status < 200;
        if (bodyless) res.resume();
        const response = new Response(
          bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
          { status, statusText: res.statusMessage ?? "", headers },
        );
        // A constructed `Response` has `url === ""`, which would silently
        // disarm the `response.url` tripwire added. Restore it to
        // the address we dialled so the tripwire keeps its meaning.
        Object.defineProperty(response, "url", { value: target.href, configurable: true });
        resolve(response);
      },
    );
    req.on("error", (error) => {
      reject(error instanceof EgressError ? error : error);
    });
    if (init.signal !== undefined) {
      const signal = init.signal;
      if (signal.aborted) {
        req.destroy(new Error("aborted"));
      } else {
        signal.addEventListener("abort", () => req.destroy(new Error("aborted")), {
          once: true,
        });
      }
    }
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Mode awareness, and saying out loud which mode is in force

/** The minimum a config must expose for the egress policy to be computed. */
export type EgressConfigView = {
  ANTHROPIC_TRIAGE_MODEL?: string;
  LOCAL_MODEL_NAME?: string | undefined;
  LOCAL_MODEL_BASE_URL?: string | undefined;
} & Partial<Record<EgressUrlVar, string | undefined>>;

/**
 * Is this run served by a local OpenAI-compatible endpoint?
 *
 * Requires `ANTHROPIC_TRIAGE_MODEL === LOCAL_MODEL_NAME` as well as both
 * `LOCAL_MODEL_*` being set, so a leftover
 * `LOCAL_MODEL_BASE_URL` in someone's environment cannot relabel — or, now,
 * re-restrict — an Anthropic run. `localConfig()` performs that substitution,
 * so this is true exactly on the `--local` path.
 */
export function isLocalEngine(config: EgressConfigView): boolean {
  const base = config.LOCAL_MODEL_BASE_URL;
  const name = config.LOCAL_MODEL_NAME;
  return (
    typeof base === "string" &&
    base !== "" &&
    typeof name === "string" &&
    name !== "" &&
    config.ANTHROPIC_TRIAGE_MODEL === name
  );
}

export type EgressEndpoint = {
  variable: EgressUrlVar;
  url: string;
  hostClass: HostClass;
};

export type EgressPolicy = {
  /** `local` enforces locality on every endpoint below; `api` does not. */
  mode: "local" | "api";
  enforced: boolean;
  endpoints: EgressEndpoint[];
};

export function egressPolicy(config: EgressConfigView): EgressPolicy {
  const local = isLocalEngine(config);
  const endpoints: EgressEndpoint[] = [];
  for (const variable of EGRESS_URL_VARS) {
    const raw = config[variable];
    if (typeof raw !== "string" || raw === "") continue;
    let hostClass: HostClass;
    let href = raw;
    try {
      const parsed = new URL(raw);
      href = parsed.href;
      hostClass = classifyHost(parsed.hostname);
    } catch {
      hostClass = "name";
    }
    endpoints.push({ variable, url: href, hostClass });
  }
  return { mode: local ? "local" : "api", enforced: local, endpoints };
}

/**
 * One sentence stating exactly what the egress rule covered on this run.
 */
export function describeEgress(config: EgressConfigView): string {
  const policy = egressPolicy(config);
  const list =
    policy.endpoints.length === 0
      ? "no HTTP endpoints configured"
      : policy.endpoints
          .map((e) => `${e.variable}=${e.url} (${e.hostClass})`)
          .join("; ");
  if (policy.enforced) {
    return (
      `egress locality ENFORCED on ${policy.endpoints.length} endpoint(s): ${list}. ` +
      "Address literals were checked at config load; names are re-checked inside the " +
      "socket's own DNS lookup, so the address validated is the address connected to. " +
      "Any non-local result refuses the connection before the request body is written."
    );
  }
  return (
    `egress locality NOT enforced (API mode): ${list}. Locality is enforced only under ` +
    "local-engine mode, where the investigation is served by an on-LAN model; in API mode " +
    "the run already talks to api.anthropic.com by design, so a LAN-only claim would be " +
    "false. Stated here rather than assumed."
  );
}

/**
 * The HTTP client the tools should use, chosen by mode.
 *
 * Local mode gets {@link localFetch}, whose connections cannot land off-LAN.
 * API mode gets the global `fetch`, because the endpoints are legitimately
 * remote there — and {@link describeEgress} records which of the two ran.
 */
export type EgressFetch = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export function egressFetch(config: EgressConfigView): EgressFetch {
  if (isLocalEngine(config)) return localFetch;
  return (input, init) => fetch(input as string | URL, init as RequestInit);
}
