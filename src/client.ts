import Anthropic from "@anthropic-ai/sdk";

import { loadConfig, type Config } from "./config.js";

/**
 * The real Anthropic API origin.
 *
 * One constant, used three ways: the default for `ANTHROPIC_BASE_URL`, the
 * origin the recorded and local transports pin their synthetic clients to, and
 * the origin `assertMessagesEndpoint` will answer. Keeping them the same
 * constant is what makes "this run talks to the real API" a checkable claim
 * rather than an assumption.
 */
export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com";

/**
 * The base URL a client built from this config WILL use.
 *
 * One function, so `createClient` and `liveTransport().describe()` cannot
 * disagree — the description is a report of the client's state, not a second
 * parallel claim about it.
 *
 * The `??` matters: a hand-built `Config` that omits the field would otherwise
 * pass `undefined` to the SDK, which is precisely the case where the SDK reads
 * `ANTHROPIC_BASE_URL` from the environment on its own. Defaulting here keeps
 * the decision inside this process either way.
 */
export function effectiveBaseUrl(config: Config): string {
  return config.ANTHROPIC_BASE_URL ?? ANTHROPIC_API_ORIGIN;
}

/**
 * Is this base URL the real Anthropic API — as a URL, not as a string?
 *
 * `describe()` compared `effectiveBaseUrl(config) === ANTHROPIC_API_ORIGIN` by
 * raw string equality, so `ANTHROPIC_BASE_URL=https://api.anthropic.com/` — the
 * same endpoint, with the trailing slash a copy-paste from a browser or a
 * `.env` line naturally carries — printed the full REDIRECTED banner claiming
 * the API key and the entire investigation were going somewhere else.
 *
 * The cost is not the wrong sentence; it is that an operator who sees the
 * banner fire on a correct configuration learns to ignore the banner, and the
 * banner is the only thing standing between a genuinely redirected run and a
 * report that misdescribes itself. A warning that cries wolf is worse than no
 * warning.
 *
 * The comparison is therefore on the parsed URL: same protocol, same host, and
 * a path that is empty or `/`. Nothing else is normalised away — a different
 * port, a path prefix, or userinfo all still read as REDIRECTED, because they
 * all genuinely are.
 */
export function isAnthropicApiOrigin(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  const real = new URL(ANTHROPIC_API_ORIGIN);
  return (
    parsed.origin === real.origin &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    (parsed.pathname === "" || parsed.pathname === "/")
  );
}

/**
 * The other environment variables SDK 0.115.0 reads on its own, at client
 * construction, when the corresponding option is omitted.
 *
 *  - **`ANTHROPIC_AUTH_TOKEN`** — `authToken` defaults to `readEnv(...)`, and
 *    an ambient value makes the client send an `Authorization: Bearer …` header
 *    alongside (or instead of) the configured key. So a run could authenticate
 *    with a credential that appears nowhere in the config, the snapshot, or
 *    `describe()`.
 *  - **`ANTHROPIC_CUSTOM_HEADERS`** — parsed into `defaultHeaders`, and the
 *    merge is `{ ...parsed, ...options.defaultHeaders }`, so any header this
 *    process does not itself set is taken from the environment. A review verified
 *    a header-replaced `X-Api-Key` reaching the wire while `describe()` went on
 *    naming the configured key as authoritative.
 *
 * The neutralisation is done by scrubbing the two variables across the
 * constructor call rather than by passing an option, because only `authToken`
 * HAS an option: `defaultHeaders` merges under the env values instead of
 * replacing them, so there is no value this process can pass that means "no
 * ambient headers". The scrub is synchronous, scoped to one `new Anthropic(…)`,
 * and restores exactly what it found.
 */
export const AMBIENT_CLIENT_ENV_VARS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

/**
 * Construct an SDK client with every ambient credential/header read neutralised.
 *
 * Every `new Anthropic(...)` in this repository goes through here — the live
 * client below and the recorded and local transports' synthetic clients — so
 * "the configured key and endpoint are authoritative" is one enforced fact
 * rather than three independent hopes.
 */
export function newAnthropicClient(options: ConstructorParameters<typeof Anthropic>[0]): Anthropic {
  return neutraliseClones(
    withAmbientEnvScrubbed(() =>
      // `authToken: null` is the explicit form of the same decision, kept even
      // though the scrub already covers it: if a future SDK reads the token from
      // somewhere other than the environment, the option still says no.
      new Anthropic({ authToken: null, ...options }),
    ),
  );
}

/** Run `fn` with the ambient variables absent, restoring exactly what was found. */
function withAmbientEnvScrubbed<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const name of AMBIENT_CLIENT_ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return fn();
  } finally {
    for (const name of AMBIENT_CLIENT_ENV_VARS) {
      const value = saved[name];
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/**
 * Make the neutralisation survive `client.withOptions()`.
 *
 * (`ANTHROPIC_AUTH_TOKEN` does not have the same hole — the clone is passed
 * `authToken: this.authToken`, which is `null` on our clients, and an explicitly
 * passed value is not defaulted from the environment. It is scrubbed here anyway
 * because the fix should be about the *class*, not about which of the two
 * happens to leak in this SDK version.)
 *
 * The fix wraps the method rather than the constructor, because the fresh
 * construction happens inside the SDK where no option we can pass reaches it:
 * every clone is built with the variables scrubbed, and the clone is wrapped the
 * same way so that a clone of a clone is covered too. `configurable` and
 * `writable` are left true so this is a neutralisation, not a lock — an
 * attacker who can rewrite our instances is §3, out of scope.
 */
function neutraliseClones(client: Anthropic): Anthropic {
  const inherited = (client as unknown as Record<string, unknown>)["withOptions"];
  if (typeof inherited !== "function") return client;
  const original = inherited as (this: Anthropic, options: unknown) => Anthropic;
  Object.defineProperty(client, "withOptions", {
    value: function (this: Anthropic, options: unknown): Anthropic {
      return neutraliseClones(
        withAmbientEnvScrubbed(() => original.call(this, options)),
      );
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return client;
}

/**
 * Where this run's Anthropic credential comes from — for `describe()`.
 */
export function describeAuthSource(): string {
  return (
    "auth: the ANTHROPIC_API_KEY in the frozen config, and nothing else — " +
    `${AMBIENT_CLIENT_ENV_VARS.join(" and ")} are neutralised at client construction ` +
    "and at every withOptions() clone of that client "
  );
}

/**
 * The single place the Anthropic client is constructed.
 *
 * : the Config this
 * takes comes from the strict `loadConfig()` — which is now also the default —
 * and the construction boundary itself validates. A Config that reaches here
 * without a non-empty `ANTHROPIC_API_KEY` throws *here*, not on the first API
 * call, so the failure surfaces at startup naming its cause rather than as an
 * opaque 401 fifteen tool calls into a triage. The diagnostic loader
 * (`loadDiagnosticConfig`) stays `env`-command-only and must never reach here.
 *
 * ##: the base URL is EXPLICIT
 *
 * The fix is truth, not defence (see docs/safety-model.md): an operator who
 * genuinely wants a gateway or proxy in front of the API is doing something
 * legitimate, and the harness has no business refusing it. What it must not do
 * is run there while claiming otherwise. So the base URL becomes a config field
 * — read at config load, frozen into the snapshot with everything else, passed
 * explicitly here — and `describe()` reports the URL the client will actually
 * use. A redirected run still runs, and says so.
 */
export function createClient(config: Config = loadConfig()): Anthropic {
  const apiKey: unknown = config.ANTHROPIC_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error(
      "createClient: ANTHROPIC_API_KEY is missing or empty. The Anthropic " +
        "client must be built from the strict loadConfig(); the diagnostic " +
        "loader is for the `env` command only.",
    );
  }

  return newAnthropicClient({ apiKey, baseURL: effectiveBaseUrl(config) });
}
