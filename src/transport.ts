import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import {
  ANTHROPIC_API_ORIGIN,
  createClient,
  describeAuthSource,
  effectiveBaseUrl,
  isAnthropicApiOrigin,
  newAnthropicClient,
} from "./client.js";
import {
  EGRESS_URL_VARS,
  assertLocalModelUrl,
  checkEgressUrl,
  describeEgress,
  isLocalEngine,
  isProvablyLocalUrl,
  localFetch,
} from "./egress.js";
import {
  assertKubeServerBelt,
  loadConfig,
  loadDiagnosticConfig,
  type Config,
} from "./config.js";
import { assertKubectlServerLocality } from "./kubeEndpoint.js";
import {
  assertRequestFitsServedWindow,
  probeOllamaContextWindow,
  type ContextWindowProbe,
} from "./contextWindow.js";
import {
  assembleLocalStream,
  toChatCompletionsRequest,
} from "./localWire.js";
import { declaredToolStatus, withoutStatus } from "./tools/status.js";

/**
 * The transport seam.
 *
 * ## The rule this file enforces
 *
 * **The transport is the only thing that changes between a dry run and a real
 * run.** Everything downstream — prompt assembly, the cached system prefix, the
 * `betaZodTool` schemas, the SDK's own `toolRunner` loop, real tool execution
 * against the real read-only cluster, the report writer and its metering
 * footer — is one code path with no mode flag in it. `runTriage()` takes a
 * `Transport` — the client and its config as one bound unit;
 * that is the whole seam.
 *
 * The recorded transport therefore substitutes at the **HTTP boundary**, not at
 * the loop boundary: it is a real `Anthropic` client with a `fetch`
 * implementation that answers `POST /v1/messages` from a committed script
 * instead of from the network. The SDK builds the request exactly as it would
 * live, parses the response exactly as it would live, and drives exactly the
 * same loop. Live cluster reads still happen for real during a dry run — they
 * need no API key.
 *
 * What a dry run therefore *does* prove: the payload parses, the prompt
 * assembles, the tool schemas accept the recorded inputs, the tool loop
 * dispatches them, the real tools execute against the real cluster and return
 * their real output, the report is written in the required shape, and the
 * grader scores it.
 */

export type TransportKind = "live" | "recorded" | "local" | "custom";

export type Transport = {
  kind: TransportKind;
  /** Config for the run. Live loads strictly; recorded never needs a key. */
  config: Config;
  client: Anthropic;
  /** One line for the run log / report provenance. */
  describe(): string;
  /** Recorded transports expose what the SDK actually sent and was answered. */
  exchanges: Exchange[];
  /**
   * Ask the server what context window it is serving this run's model with. Present ONLY on transports whose window is a choice some server
   * made — today that is `localTransport` alone.
   *
   * Absent is meaningful and is not the same as `undeterminable`: the Anthropic
   * API serves a fixed, published window, and a recorded replay answers from a
   * committed fixture, so neither has a served window to read. `runTriage`
   * therefore skips the gate when this is absent, and refuses the run when it is
   * present and reports `undeterminable`. Folding the two together is the
   * failure this whole module exists to prevent — see `src/contextWindow.ts`.
   */
  probeContextWindow?: () => Promise<ContextWindowProbe>;
};

export type Exchange = {
  turn: number;
  request: unknown;
  response: BetaMessage;
};

/**
 * A transport's private, immutable snapshot of its config.
 *
 * The fix captures the DECISION, not the object: every transport takes a
 * shallow frozen copy at construction and holds only that. Two independent
 * properties close the class:
 *
 *  - later mutation of the caller's own object is simply irrelevant — the
 *    transport, its `describe()`, and the config it hands `runTriage` (and so
 *    every `egressFetch(config)` inside the tools) all read the snapshot;
 *  - mutation attempts on `transport.config` itself throw in strict mode
 *    (all modules here are ESM-strict) instead of silently succeeding.
 *
 * A shallow copy is a complete copy: the config schema (`src/config.ts`) is a
 * single flat `z.object` of primitives — there is no nested object through
 * which a mutation could reach the snapshot. If a nested field is ever added,
 * this must become a deep freeze; the assertion in the offline check suite that
 * walks the snapshot's values pins that.
 */
export function frozenConfigSnapshot(config: Config): Config {
  return Object.freeze({ ...config }) as Config;
}

// ---------------------------------------------------------------------------
// Client↔config binding
//
// The structural fix: the PAIR is the unit. Every factory in this file records
// its client → frozen-snapshot binding in a module-private WeakMap at the one
// moment the pairing is created, and `runTriage` consumes a `Transport` and
// refuses — via `assertTransportPairing` — any whose client is unbound or bound
// to a different config than the one riding next to it. There is no signature
// left through which an unfrozen or mismatched config reaches tool
// construction, and a caller holding inconsistent halves is refused loudly
// rather than silently re-snapshotted: inconsistent halves are a bug worth
// surfacing, not repairing.

const BOUND_CONFIGS = new WeakMap<Anthropic, Config>();

function bindPair(client: Anthropic, config: Config): void {
  BOUND_CONFIGS.set(client, config);
}

// ---------------------------------------------------------------------------
// The test-pairing gate
//
//  1. **The helper is not in this module, and not in the shipped build.** The
//     transport-shaped helper now lives in `scripts/testTransport.ts`.
//     `tsconfig.json` compiles `src/**` only and `package.json` ships `dist`,
//     so the helper is not merely uncalled by production code — it is not
//     PRESENT in what production runs, and no import graph rooted at
//     `src/index.ts` can reach it. That is asserted structurally, by walking
//     imports, not by grepping for a name.
//
// What this does NOT claim: that an attacker who can already set this process's
// environment, or reach into its module registry, is stopped. Such an attacker
// owns the process (see docs/safety-model.md, out-of-scope adversaries). The
// claim is the one this chain has always been about — that the harness's own
// description of itself is TRUE: there is no door on the production surface,
// and the production surface is now a fact about the build, not about a name.

// The gate is therefore TWO conditions, and the second one cannot be inherited:
//
//  1. the environment variable, as before — the operator-visible half; and
//  2. an IN-PROCESS arming call, `armUnsafeTestPairing()`. A module-private
//     boolean. It cannot be carried by an environment, a `.env` file, a shell
//     export, a launchd plist, or a copied command line. A script that wants it
//     must contain the call, spelled `armUnsafeTestPairing`, in its own source.
//
// And arming can be SEALED. `sealUnsafeTestPairing()` disables it irrevocably
// for the lifetime of the process; `src/index.ts` calls it at startup, so the
// CLI can never be armed even by code that runs later.
//
// Enforcement is at the pairing/run boundary shared by every production
// entrypoint — `assertTransportPairing`, which `runTriage` calls on every run
// and which `runReplay` therefore inherits — not in one CLI's startup. The
// startup deletion in `src/index.ts` is kept, but it is now belt rather than
// braces: with the variable left set, an unarmed process still refuses.

// The shape of the fix, deliberately not "remove the export": eleven check-suite
// call sites legitimately need to pair synthetic wire-shape clients (R4), and
// `scripts/testTransport.ts` can only reach the WeakMap through an export. So
// **the primitive carries the wrapper's refusals**, and the run boundary
// re-applies them to the state at RUN time rather than trusting the state at
// PAIRING time:
//
// The property this establishes, and the one to re-check in review: **no
// sequence of calls available to an importing library process can get a
// non-local client past the run boundary in local mode.** Steps 4 and 5 of
// The review's chain now throw, and step 7 would throw even if they did not.

/** The environment variable that forms HALF of the test-pairing gate. */
export const UNSAFE_TEST_TRANSPORT_GATE = "SRE_AGENT_UNSAFE_TEST_TRANSPORT";
/** The only value that opens it. Anything else — including "1" — is closed. */
export const UNSAFE_TEST_TRANSPORT_GATE_VALUE = "check-suite";

/** Clients paired by the test primitive, so the gate can be re-checked at run time. */
const TEST_BOUND_CLIENTS = new WeakSet<Anthropic>();

/**
 * The non-inheritable half of the gate. Module-private, per-process, never
 * serialised.
 */
let testPairingDepth = 0;
/** Once sealed, arming is impossible for the rest of this process's life. */
let testPairingSealed = false;

/** Is the environment half of the gate open? */
export function unsafeTestPairingEnvOpen(): boolean {
  return process.env[UNSAFE_TEST_TRANSPORT_GATE] === UNSAFE_TEST_TRANSPORT_GATE_VALUE;
}

/** Is the in-process half armed? (Any scoped or explicit holder open.) */
export function unsafeTestPairingArmed(): boolean {
  return testPairingDepth > 0;
}

/**
 * Arm the in-process half of the gate — one HOLD. Only a check runner may call
 * this, and — the point of the whole mechanism — a script that has not been
 * *written* to call it cannot acquire it by inheriting an environment. Each hold
 * is released by exactly one `disarmUnsafeTestPairing`/scope exit; the gate is
 * open while any hold is outstanding.
 */
export function armUnsafeTestPairing(): void {
  if (testPairingSealed) {
    throw new TransportError(
      "refusing to arm the test-pairing gate: it has been sealed for this process. A " +
        "production entrypoint (src/index.ts) seals it at startup, so a CLI process can " +
        "never pair a hand-built client no matter what runs afterwards.",
    );
  }
  testPairingDepth += 1;
}

/**
 * Arm for the duration of ONE bracketed region, then restore what was there
 * before — including "unarmed".
 *
 * ##, third defect
 *
 * The offline check suite armed once at the top of `main()` and left the process
 * globally armed across nearly its whole async run, so any concurrent code in
 * that process sat inside the window. A process-global boolean with no scope is
 * the wrong shape for a capability that is only ever wanted around a handful of
 * synchronous constructions.
 *
 * This does not make arming unreachable — a library process can call this too —
 * and it is not what closes the finding. What closes the finding is that the
 * primitive and the run boundary refuse a local-mode config and a non-Anthropic
 * client origin *whatever* the arm says. This narrows the window in the one
 * process that legitimately opens it.
 */
export async function withUnsafeTestPairing<T>(fn: () => Promise<T>): Promise<T> {

  armUnsafeTestPairing();
  try {
    return await fn();
  } finally {
    testPairingDepth = Math.max(0, testPairingDepth - 1);
  }
}

/**
 * Disarm the in-process half — release ALL holds (hard "off"). Used by the check
 * suite to prove pairing/running fail closed, and by `closeUnsafeTestPairingGate`.
 * A hard reset rather than a single release: "disarm" means the gate is shut, and
 * the scoped `withUnsafeTestPairing` releases its own hold via decrement, never
 * through here.
 */
export function disarmUnsafeTestPairing(): void {
  testPairingDepth = 0;
}

/** Disable arming for the rest of this process. Called by production entrypoints. */
export function sealUnsafeTestPairing(): void {
  testPairingDepth = 0;
  testPairingSealed = true;
}

/** Is the check-suite-only gate open in THIS process, right now? BOTH halves. */
export function unsafeTestPairingAllowed(): boolean {
  return unsafeTestPairingEnvOpen() && testPairingDepth > 0;
}

/** Which half is shut, for a refusal message that names the actual cause. */
function closedGateReason(): string {
  const envOpen = unsafeTestPairingEnvOpen();
  const armed = testPairingDepth > 0;
  if (!envOpen && !armed) {
    return `neither ${UNSAFE_TEST_TRANSPORT_GATE}=${UNSAFE_TEST_TRANSPORT_GATE_VALUE} nor the ` +
      "in-process arm (armUnsafeTestPairing) is set";
  }
  if (!envOpen) {
    return `${UNSAFE_TEST_TRANSPORT_GATE}=${UNSAFE_TEST_TRANSPORT_GATE_VALUE} is not set`;
  }
  return (
    `${UNSAFE_TEST_TRANSPORT_GATE} is set, but the in-process arm is not: this process never ` +
    "called armUnsafeTestPairing()" +
    (testPairingSealed ? ", and arming is SEALED (a production entrypoint ran)" : "") +
    ". The environment variable alone is deliberately insufficient — a script copied into an " +
    "operational runner carries its environment but not a call it does not contain"
  );
}

/**
 * TEST-ONLY primitive: bind a caller-supplied client to a snapshot of a config.
 *
 * Refuses unless the check-suite gate is open. This is the only way a client no
 * factory built can enter `BOUND_CONFIGS`, and the transport-shaped helper that
 * wraps it (`scripts/testTransport.ts`) is outside the production build
 * entirely. Returns the frozen snapshot the caller must ride beside.
 */
/**
 * The one origin a client paired through the test primitive may be aimed at.
 */
export const TEST_PAIR_ALLOWED_ORIGIN = ANTHROPIC_API_ORIGIN;

/**
 * A real `Anthropic` client's `baseURL` as an origin.
 */
function clientOrigin(client: Anthropic): string | undefined {
  const baseURL = client.baseURL;
  if (typeof baseURL !== "string" || baseURL === "") return undefined;
  try {
    return new URL(baseURL).origin;
  } catch {
    return undefined;
  }
}

/**
 * The shapes a test-door pairing may never have — checked at PAIRING time and
 * again at RUN time, because all are mutable between the two.
 *
 * `where` names the moment, so a refusal says whether the state was wrong when
 * the pair was created or when the run started (a `baseURL` moved after pairing
 * is a different bug from one that was wrong all along).
 */
function assertTestPairShape(client: Anthropic, config: Config, where: "pairing" | "run"): void {

  if (!(client instanceof Anthropic)) {
    throw new TransportError(
      `refusing a hand-built client at ${where} time: it is not an Anthropic SDK instance. The ` +
        "test-pairing door exists to bind synthetic wire-shape clients built by the SDK; an " +
        "object that merely looks client-shaped has no baseURL this process can trust to decide " +
        "where it sends the investigation, so it cannot be paired or run.",
    );
  }
  if (isLocalEngine(config)) {
    throw new TransportError(
      `refusing a hand-built client at ${where} time: its config is in local-engine mode. ` +
        "Local mode's whole claim is that the investigation cannot leave the LAN, and a " +
        "hand-built client's `fetch` is an arbitrary function — no inspection decides where it " +
        "sends the system prompt and the alert. Only localTransport() may pair a local-engine " +
        "config, because only its client dials the endpoint through localFetch, whose " +
        "connections are validated inside the socket's own DNS lookup. This refusal is " +
        "unconditional: no state of the check-suite gate permits it.",
    );
  }
  const origin = clientOrigin(client);

  if (origin !== TEST_PAIR_ALLOWED_ORIGIN) {
    throw new TransportError(
      `refusing a hand-built client at ${where} time: its baseURL origin is ` +
        `${JSON.stringify(origin ?? "(absent or unparseable)")}, not ${TEST_PAIR_ALLOWED_ORIGIN}. ` +
        `A client aimed anywhere ` +
        "else is either a local inference client — which belongs to localTransport(), the only " +
        "factory that can keep the sovereignty claim honest — or an endpoint this harness would " +
        "refuse to speak to anyway (assertMessagesEndpoint answers exactly this origin). The " +
        "rule is an exact-origin allowlist rather than a locality predicate on purpose: " +
        "`http://localhost:1234/v1` is a NAME, so it is not 'provably local', and a predicate " +
        "whose undecidable answer folds into 'accept' lets every name through. Checked again " +
        "here at run time because `baseURL` is a writable instance property.",
    );
  }
}

export function unsafeBindTestPair(client: Anthropic, configInput: Config): Config {

  assertTestPairShape(client, configInput, "pairing");
  if (!unsafeTestPairingAllowed()) {
    throw new TransportError(
      `refusing to pair a hand-built client: the check-suite gate is closed — ${closedGateReason()}. ` +
        "This primitive exists only so the offline check suite can construct synthetic wire-shape " +
        "clients. A hand-built client's `fetch` is an arbitrary function, so no inspection can " +
        "prove where it sends the investigation — which is why production offers no door for " +
        "one at all.",
    );
  }
  if (BOUND_CONFIGS.has(client)) {
    throw new TransportError(
      "refusing to re-pair a client that already belongs to a transport: binding it to a " +
        "second config would let the tools run on a config the inference path has never " +
        "seen. Pass the original transport itself.",
    );
  }
  const config = frozenConfigSnapshot(configInput);
  bindPair(client, config);
  TEST_BOUND_CLIENTS.add(client);
  return config;
}

/** The frozen config a factory bound to this client, if any. */
export function boundConfigOf(client: Anthropic): Config | undefined {
  return BOUND_CONFIGS.get(client);
}

/**
 * Refuse any transport whose client and config are not the pair a factory
 * created together. Called by `runTriage` on every run.
 */
export function assertTransportPairing(transport: Transport): void {
  const bound = BOUND_CONFIGS.get(transport.client);

  if (TEST_BOUND_CLIENTS.has(transport.client)) {
    assertTestPairShape(transport.client, transport.config, "run");
  }
  if (TEST_BOUND_CLIENTS.has(transport.client) && !unsafeTestPairingAllowed()) {
    throw new TransportError(
      "refusing to run: this transport's client was paired through the TEST-ONLY door " +
        `(unsafeBindTestPair), and the check-suite gate is not open in this process — ` +
        `${closedGateReason()}. Such a client's egress is unverified by construction — its ` +
        "`fetch` is an arbitrary function. Production runs must use a factory transport " +
        "(liveTransport / recordedTransport / localTransport).",
    );
  }
  if (bound === undefined) {
    throw new TransportError(
      "refusing to run: this transport's client was not built by a transport factory " +
        "(liveTransport / recordedTransport / localTransport), so there is no record of " +
        "which config it belongs to. A client paired with a config it did not come from " +
        "can keep inference local while the tools egress unrestricted. There is no " +
        "production door for hand-built clients: the helper that pairs one lives outside " +
        "the shipped build (scripts/testTransport.ts) and its primitive here refuses unless " +
        "the check suite has opened BOTH halves of the gate — the environment variable and " +
        "an in-process arming call that no inherited environment can supply.",
    );
  }
  if (bound !== transport.config) {
    throw new TransportError(
      "refusing to run: this transport's `config` is not the config its client was built " +
        "from. Handing runTriage mismatched halves would build the tools — and their " +
        "egress policy — from a config the inference client has never seen; that is how a " +
        "mutated original re-arms the unrestricted global fetch behind a still-local " +
        "client. Pass the factory-built transport unchanged; the pairing is deliberate " +
        "and a mismatch is a caller bug, not something to silently repair.",
    );
  }
}

/** Real SDK path. Requires `ANTHROPIC_API_KEY`. */
export function liveTransport(configInput: Config = loadConfig()): Transport {
  // Same mutation shape as the local transport, lower stakes:
  // API mode makes no locality promise, and mutating a live config toward
  // local-engine mode would move the tools to the MORE restrictive localFetch.
  // The snapshot is still taken, because a transport whose describe() and
  // model attribution can drift after construction is a provenance bug even
  // when it is not an egress bug.
  const config = frozenConfigSnapshot(configInput);
  const client = createClient(config);
  // The pairing is created here and recorded here: runTriage
  // will refuse this client next to any other config.
  bindPair(client, config);
  return {
    kind: "live",
    config,
    client,

    describe: () =>
      (isAnthropicApiOrigin(effectiveBaseUrl(config))
        ? `live transport — real Anthropic API (${ANTHROPIC_API_ORIGIN}), model ` +
          `${config.ANTHROPIC_TRIAGE_MODEL}`
        : `live transport — REDIRECTED: this run talks to ${effectiveBaseUrl(config)}, not ` +
          `the Anthropic API at ${ANTHROPIC_API_ORIGIN}. ANTHROPIC_BASE_URL is set, so the ` +
          `API key and the entire investigation go to that endpoint. Model ` +
          `${config.ANTHROPIC_TRIAGE_MODEL}, as named to that endpoint.`) +
      ` (${describeAuthSource()})`,
    exchanges: [],
  };
}

// ---------------------------------------------------------------------------
// Recorded transport

export type RecordedToolUse = {
  name: string;
  input: Record<string, unknown>;
};

export type RecordedTurn = {
  /** Optional assistant prose emitted alongside the tool calls. */
  text?: string;
  /** Tool calls the recorded assistant makes on this turn. */
  tool_uses?: RecordedToolUse[];
};

export type RecordedScript = {
  turns: RecordedTurn[];
};

export class TransportError extends Error {
  /**
   * Is retrying this failure meaningful — or is it a REFUSAL that would refuse
   * again, identically, on every attempt?
   *
   * Default FALSE. A refusal that forgets to opt out is retried, so the safe
   * default is the one that does not re-attempt a control.
   */
  readonly retryable: boolean;

  constructor(message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Is this failure — as it arrives at a CALLER, wrapped — worth re-attempting?
 *
 * The SDK buries the transport's own diagnosis in `.cause` under a generic
 * `APIConnectionError`, so the answer is only reachable by walking the chain.
 * That walk lives here rather than in the caller for the reason above: the
 * decision belongs to the layer that made it, and a second copy in a script is
 * a second thing to keep true. Anything that is not (or does not wrap) a
 * `TransportError` is NOT retryable — an unrecognised failure gets the same
 * conservative answer as a refusal.
 */
export function isRetryableFailure(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 8; depth++) {
    if (e instanceof TransportError) return e.retryable;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request validation
//
// The mock previously accepted `url.includes("/v1/messages")` — which also
// matches `/v1/messages/batches` and `https://evil.invalid/?x=/v1/messages` —
// and turned an unparseable body into `{ unparsed: true }` plus a synthetic
// 200. A mock that accepts requests the real API would reject is a mock that
// hides bugs: the whole value of substituting at the HTTP boundary is that the
// SDK has to build a *real* request, and nothing checked that it had.

/** Fields the real Messages API requires. Kept deliberately shallow. */
export type MessagesRequest = {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string; input_schema?: unknown }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exact-match the endpoint. `POST` to a pathname *equal to* `/v1/messages`,
 * with no query string — nothing else is the Messages API.
 */
export function assertMessagesEndpoint(url: string, method: string): void {
  if (method.toUpperCase() !== "POST") {
    throw new TransportError(
      `dry-run transport refuses ${method} ${url}: it only answers POST /v1/messages.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url, "https://api.anthropic.com");
  } catch {
    throw new TransportError(`dry-run transport could not parse the request URL "${url}".`);
  }
  // HOST, then path.: the path check alone
  // accepted `https://evil.invalid/v1/messages`. Nothing here reaches the
  // network either way — the whole point of the fake `fetch` is that it does
  // not — but a mock that answers for an arbitrary host would answer a
  // *misconfigured base URL* with a scripted 200 instead of surfacing it, and
  // the request the SDK built is the thing this seam exists to check.
  if (parsed.protocol !== "https:" || parsed.host !== "api.anthropic.com") {
    throw new TransportError(
      `dry-run transport refuses ${method} ${parsed.protocol}//${parsed.host}${parsed.pathname}: ` +
        "it only answers the real Messages endpoint on https://api.anthropic.com. A request " +
        "aimed anywhere else is a misconfigured base URL, not a scripted turn.",
    );
  }
  // Path EQUALITY, not substring. This is what defeats the sibling endpoint
  // (`/v1/messages/batches`) and query-string smuggling
  // (`https://api.anthropic.com/collect?x=/v1/messages`, pathname `/collect`).
  //
  // A query string is allowed and deliberately not constrained: the SDK really
  // does send `POST /v1/messages?beta=true`, the real API really does accept
  // it, and a mock that rejected it would be strict in a way the real endpoint
  // is not — which is the same class of mistake in the other direction.
  if (parsed.pathname !== "/v1/messages") {
    throw new TransportError(
      `dry-run transport refuses ${method} ${parsed.pathname}${parsed.search}: it only ` +
        "answers POST to a path equal to /v1/messages. Nothing here reaches the network.",
    );
  }
}

/**
 * Parse and validate the request body the way the real API would: unparseable
 * JSON is an error, not a `{ unparsed: true }` placeholder answered with 200.
 */
export function parseMessagesRequest(body: unknown): MessagesRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(body ?? ""));
  } catch (error) {
    throw new TransportError(
      "dry-run transport refuses a request whose body is not JSON " +
        `(${error instanceof Error ? error.message : String(error)}). The real API ` +
        "would return 400; silently faking a 200 would hide a malformed request.",
    );
  }
  if (!isRecord(parsed)) {
    throw new TransportError("dry-run transport refuses a request body that is not a JSON object.");
  }

  const bad = (why: string): never => {
    throw new TransportError(
      `dry-run transport refuses a request the real API would reject: ${why}.`,
    );
  };

  const model = parsed["model"];
  if (typeof model !== "string" || model === "") bad("`model` is missing or not a non-empty string");

  const maxTokens = parsed["max_tokens"];
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    bad("`max_tokens` is missing or not a positive integer");
  }

  const messages = parsed["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    bad("`messages` is missing or empty");
  }
  for (const [i, message] of (messages as unknown[]).entries()) {
    if (!isRecord(message)) bad(`messages[${i}] is not an object`);
    const role = (message as Record<string, unknown>)["role"];
    if (role !== "user" && role !== "assistant") {
      bad(`messages[${i}].role is ${JSON.stringify(role)}, not "user" or "assistant"`);
    }
    // : `"content" in message` accepted
    // `content: null`, which the real API rejects. The real contract is a
    // non-empty string or a non-empty array of blocks.
    const messageContent = (message as Record<string, unknown>)["content"];
    if (typeof messageContent === "string") {
      if (messageContent === "") bad(`messages[${i}].content is an empty string`);
    } else if (Array.isArray(messageContent)) {
      if (messageContent.length === 0) bad(`messages[${i}].content is an empty array`);
      for (const [j, part] of messageContent.entries()) {
        if (!isRecord(part)) bad(`messages[${i}].content[${j}] is not a content block`);
        if (typeof (part as Record<string, unknown>)["type"] !== "string") {
          bad(`messages[${i}].content[${j}] has no \`type\``);
        }
      }
    } else {
      bad(
        `messages[${i}].content is ${messageContent === null ? "null" : typeof messageContent}, ` +
          "not a non-empty string or array of content blocks",
      );
    }
  }

  const tools = parsed["tools"];
  if (tools !== undefined) {
    if (!Array.isArray(tools)) bad("`tools` is present but not an array");
    for (const [i, tool] of (tools as unknown[]).entries()) {
      if (!isRecord(tool)) bad(`tools[${i}] is not an object`);
      const name = (tool as Record<string, unknown>)["name"];
      if (typeof name !== "string" || name === "") bad(`tools[${i}].name is missing or empty`);
      const schema = (tool as Record<string, unknown>)["input_schema"];
      if (!isRecord(schema)) bad(`tools[${i}].input_schema is missing or not an object`);
    }
  }

  return parsed as unknown as MessagesRequest;
}

// ---------------------------------------------------------------------------
// Tool-result gating

/**
 * How a tool result is judged usable.
 *
 * ##: the mechanism, not the miss
 *
 * This used to be `FAILED_RESULT_RE`, a hand-maintained list of text shapes
 * meaning "this tool ran and did not work". It was written when `kubectl_read`
 * and `promql_query` were the only tools, and then added
 * `docs_search` / `docs_read`, which report failure as an ordinary result
 * string (`DOCUMENTATION RETRIEVAL FAILED`) with no `is_error`. A dry run could
 * lose the entire documentation corpus and still advance to a scripted PASS.
 *
 * Adding `DOCUMENTATION RETRIEVAL FAILED` to the list would have fixed that one
 * miss and left the mechanism — default-usable, reject only what someone
 * remembered to enumerate — intact for the next tool. So the default is
 * inverted: every tool result must **declare** its outcome as its last line
 * (`src/tools/status.ts`), and an undeclared result is unusable. A tool added
 * without a declaration now fails loudly on its first dry run.
 */
export type ToolFailure = {
  toolUseId: string;
  /** Which tool produced it, from the `tool_use` block that requested it. */
  tool: string;
  /** 1-based index of the assistant turn that issued the call. */
  turn: number;
  reason: "is_error" | "declared-failed" | "undeclared";
  text: string;
  /**
   * Who issued the call this result answers.
   *
   * `"model"` — the scripted model asked for it. This is what the replay gate
   * below is about, and its `turn` is the **model** turn, i.e. the scripted
   * turn number a scenario's `expectedToolFailures` entry names.
   */
  origin: "model" | "harness";
};

function toolResultText(block: Record<string, unknown>): string {
  const content = block["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part["text"] === "string" ? part["text"] : JSON.stringify(part),
      )
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

/**
 * Failed `tool_result` blocks in the most recent user turn of a request.
 *
 * The SDK's `toolRunner` appends the previous turn's results as the newest
 * user message, so inspecting that message is exactly "did the preceding
 * turn's tool calls work". Exported so the check suite can assert the gate
 * without running a replay.
 */
/**
 * Which tool issued each `tool_use`, and on which assistant turn.
 *
 * Needed by `assertToolResultsUsable`: an allowance is bound to a tool name and
 * a turn, and neither is present on the
 * `tool_result` block itself — only the `tool_use` that requested it carries
 * the name, and the turn is that block's position in the conversation.
 */
function toolUseOrigins(
  messages: readonly unknown[],
): Map<string, { tool: string; turn: number }> {
  const origins = new Map<string, { tool: string; turn: number }>();
  let assistantTurn = 0;
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    assistantTurn += 1;
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "tool_use") continue;
      const id = block["id"];
      const name = block["name"];
      if (typeof id === "string" && typeof name === "string") {
        origins.set(id, { tool: name, turn: assistantTurn });
      }
    }
  }
  return origins;
}

/**
 * @param harnessAssistantTurns how many assistant turns at the head of the
 * conversation the HARNESS authored (the evidence sweep: 0 or 1). Supplied by
 * `src/replay.ts` from `runTriage`'s own sweep outcome — never inferred from
 * the wire, so a model cannot claim a turn of its own is harness-authored by
 * imitating an id or a preamble. Turns at or below it are `origin: "harness"`;
 * everything above is a model turn, renumbered so that model turn 1 is the
 * script's first turn with or without a sweep in front of it.
 */
export function failedToolResults(
  request: unknown,
  harnessAssistantTurns = 0,
): ToolFailure[] {
  if (!isRecord(request)) return [];
  const messages = request["messages"];
  if (!Array.isArray(messages)) return [];
  const origins = toolUseOrigins(messages);

  const failures: ToolFailure[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isRecord(message) || message["role"] !== "user") continue;
    const content = message["content"];
    if (!Array.isArray(content)) break;
    const results = content.filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) && block["type"] === "tool_result",
    );
    if (results.length === 0) break;
    for (const block of results) {
      const id = String(block["tool_use_id"] ?? "(unknown)");
      const text = toolResultText(block);
      const origin = origins.get(id);
      const conversationTurn = origin?.turn ?? 0;
      const harnessIssued = conversationTurn > 0 && conversationTurn <= harnessAssistantTurns;
      const base = {
        toolUseId: id,
        tool: origin?.tool ?? "(unknown)",
        // Model turns are renumbered past the harness prefix; a harness turn
        // keeps its own 1-based index within that prefix.
        // An unknown origin keeps 0 — "we never saw the call that asked for
        // this" must not be renumbered into a plausible-looking turn.
        turn:
          conversationTurn === 0
            ? 0
            : harnessIssued
              ? conversationTurn
              : conversationTurn - harnessAssistantTurns,
        text,
        origin: harnessIssued ? ("harness" as const) : ("model" as const),
      };
      if (block["is_error"] === true) {
        failures.push({ ...base, reason: "is_error" });
        continue;
      }
      const status = declaredToolStatus(text);
      if (status === "failed") failures.push({ ...base, reason: "declared-failed" });
      else if (status === "undeclared") failures.push({ ...base, reason: "undeclared" });
    }
    break;
  }
  return failures;
}

export type ExpectedToolFailure = {
  id: string;
  /** The tool whose failure is allowed. Names one tool; no wildcard exists. */
  tool: string;
  /** The 1-based assistant turn whose call is allowed to fail. */
  turn: number;
  pattern: string;
  flags: string;
  why: string;
};

/**
 * Fail the replay loudly when the previous turn's tool calls did not work.
 *
 * An allowance used to be a bare regex matched against the failure *text*, so
 * `[\s\S]*` — or any other pattern that matches everything — restored exactly
 * the permissive behaviour the gate was built to remove, from inside the
 * scenario data the gate is supposed to constrain. Three things changed:
 *
 *  1. an allowance names **one tool** and **one turn**, so it excuses the
 *     specific recorded call it was written for and nothing else;
 *  2. the pattern itself is refused at schema-load time if it is trivially
 *     over-broad (`src/scenario.ts`), so a wildcard cannot be committed; and
 *  3. an allowance that matches nothing in a run is *not* an error — the
 *     recorded NotFound may simply not have happened — but an allowance can no
 *     longer excuse a failure it was not written about.
 *
 * (2) blocked patterns that match things a failure does not contain, and missed
 * the mirror image: text that **every** failure contains. `[[tool-status:
 * failed]]` terminates every declared failure by construction, so an allowance
 * whose pattern was exactly that marker cleared the specificity floor, cleared
 * every over-breadth probe, and excused every failure shape for its tool and
 * turn — the wildcard again, wearing the gate's own vocabulary.
 *
 * The pattern is therefore matched against the failure's **substance**:
 * `withoutStatus(text)`, the result with its status declaration removed. The
 * marker is not part of the matchable surface at all, so an allowance can only
 * be written about what actually went wrong. A marker-only pattern now matches
 * nothing and excuses nothing — it fails closed. (`src/scenario.ts` also
 * refuses such a pattern at load time, so it is reported rather than merely
 * inert.) The error text below still prints the full result, markers included,
 * because a human debugging a stopped replay wants everything.
 *
 * With the evidence sweep on, the conversation opens with an assistant turn the
 * HARNESS wrote. Two consequences, both handled by `harnessAssistantTurns`
 * rather than by relaxing anything:
 *
 *  1. **A scenario's `turn` still means the scripted turn it always meant.**
 *     `prometheus-wal-eio` declares a NotFound on turn 4; with a sweep in front
 *     of it that call sits on conversation turn 5. Renumbering here is what
 *     stops the allowance silently ceasing to match — which would have made the
 *     gate *stricter by accident* and stopped a replay for a reason nobody
 *     wrote down.
 *  2. **A failed sweep read is not a replay-stopper.** The gate's stated
 *     purpose is that a scripted report must not be returned on top of failed
 *     tool calls *the script asked for*; the script asked for none of the
 *     sweep's, and a scenario has no turn to declare them on. So harness-issued
 *     failures are excluded here and recorded instead — in the report's sweep
 *     table, in `describeSweepMode`, and in the transcript's `sweep` block. The
 *     model half of the rule is untouched: every model-issued failure still
 *     needs an allowance naming its tool and its turn.
 */
export function assertToolResultsUsable(
  request: unknown,
  allowed: readonly ExpectedToolFailure[],
  harnessAssistantTurns = 0,
): void {
  const undeclared = failedToolResults(request, harnessAssistantTurns).filter(
    (failure) =>
      failure.origin !== "harness" &&
      !allowed.some(
        (spec) =>
          spec.tool === failure.tool &&
          spec.turn === failure.turn &&
          // 5c/5: the failure's substance, never its universal status marker.
          new RegExp(spec.pattern, spec.flags).test(withoutStatus(failure.text)),
      ),
  );
  if (undeclared.length === 0) return;
  throw new TransportError(
    `dry-run transport refuses to advance: ${undeclared.length} tool result(s) from the ` +
      "preceding turn are not usable, and no `expectedToolFailures` entry in the scenario " +
      "declares them for that tool on that turn. Returning the scripted report on top of " +
      "failed tool calls would produce a PASS that proves nothing.\n" +
      undeclared
        .map(
          (f) =>
            `  - ${f.tool} turn ${f.turn} (${f.toolUseId}) [${f.reason}]: ` +
            (f.reason === "undeclared"
              ? "the result declares no outcome. Every tool must end its result with the " +
                "marker from src/tools/status.ts; an undeclared result is treated as failed. "
              : "") +
            f.text.slice(0, 300).replace(/\n/g, " ⏎ "),
        )
        .join("\n"),
  );
}

function contentFor(turn: RecordedTurn, index: number): BetaContentBlock[] {
  const blocks: BetaContentBlock[] = [];
  if (turn.text !== undefined && turn.text !== "") {
    blocks.push({ type: "text", text: turn.text, citations: null });
  }
  for (const [i, use] of (turn.tool_uses ?? []).entries()) {
    blocks.push({
      type: "tool_use",
      id: `toolu_dryrun_${index}_${i}`,
      name: use.name,
      input: use.input,
    });
  }
  if (blocks.length === 0) {
    throw new TransportError(
      `recorded turn ${index} has neither \`text\` nor \`tool_uses\` — it would ` +
        "produce an empty assistant message, which the report writer rejects.",
    );
  }
  return blocks;
}

export type RecordedTransportOptions = {
  /**
   * Tool-result failures this scenario declares as expected. Everything else
   * stops the replay — see `assertToolResultsUsable`.
   */
  expectedToolFailures?: readonly ExpectedToolFailure[];

  harnessAssistantTurns?: () => number;
};

/**
 * An `Anthropic` client whose `fetch` answers from a script.
 *
 * Deliberately strict about what it will answer, in three ways, each of which
 * exists because the looser version hid something:
 *
 *  1. **Endpoint.** Only a `POST` to `https://api.anthropic.com` whose pathname
 *     *equals* `/v1/messages`. A substring test also matched
 *     `/v1/messages/batches`; a path-only test also matched
 *     `https://evil.invalid/v1/messages`.
 *  2. **Request shape.** The body must be JSON and must carry what the real
 *     API requires (`model`, positive `max_tokens`, non-empty well-formed
 *     `messages` with non-null content, well-formed `tools`). Unparseable
 *     bodies used to become `{ unparsed: true }` and still get a 200.
 *  3. **Tool results.** Before advancing to the next scripted turn, the
 *     preceding turn's `tool_result` blocks must each *declare* success. The
 *     turn counter alone would hand back the scripted final report even if
 *     every tool call had errored.
 *
 * These are a **floor, not a model of the API.** This is not a validator: a
 * request can satisfy all three and still be one the real endpoint would
 * reject — wrong parameter combinations, bad `cache_control` placement, an
 * over-budget `max_tokens`, a tool schema the server dislikes. What the three
 * buy is that the failures they *do* cover fail loudly here instead of being
 * answered with a scripted 200. Only a live run tests the request properly.
 */
export function recordedTransport(
  script: RecordedScript,
  options: RecordedTransportOptions = {},
): Transport {
  if (script.turns.length === 0) {
    throw new TransportError("recorded script has no turns");
  }
  const expectedToolFailures = options.expectedToolFailures ?? [];
  const harnessAssistantTurns = options.harnessAssistantTurns ?? ((): number => 0);

  const exchanges: Exchange[] = [];
  let turnIndex = 0;

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    assertMessagesEndpoint(url, method);

    // Validate the request BEFORE consuming a scripted turn: a malformed
    // request must not silently burn a turn on its way to failing.
    const request = parseMessagesRequest(init?.body);
    assertToolResultsUsable(request, expectedToolFailures, harnessAssistantTurns());

    const turn = script.turns[turnIndex];
    if (turn === undefined) {
      throw new TransportError(
        `recorded script exhausted: the loop asked for turn ${turnIndex + 1} ` +
          `but the script has ${script.turns.length}. Either the tool loop took ` +
          "an unrecorded path or the script is short a final text-only turn.",
      );
    }
    turnIndex += 1;

    const content = contentFor(turn, turnIndex);
    const usesTools = content.some((b) => b.type === "tool_use");
    const message = {
      id: `msg_dryrun_${turnIndex}`,
      type: "message",
      role: "assistant",
      model: request.model,
      content,
      stop_reason: usesTools ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as unknown as BetaMessage;

    exchanges.push({ turn: turnIndex, request, response: message });

    return new Response(JSON.stringify(message), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "request-id": `req_dryrun_${turnIndex}`,
      },
    });
  };

  // No key is needed and none is read: the fetch above never reaches the
  // network. The placeholder exists only because the SDK requires the field.
  // Frozen like every transport's config: nobody holds a
  // reference to mutate this one, but the invariant is cheapest stated as
  // "transports hold immutable snapshots", not "except the recorded one".
  const config = frozenConfigSnapshot({
    ...loadDiagnosticConfig(),
    ANTHROPIC_API_KEY: "",
  } as Config);

  const client = newAnthropicClient({
    apiKey: "dry-run-no-network",
    maxRetries: 0,

    baseURL: ANTHROPIC_API_ORIGIN,
    fetch: fetchImpl as unknown as typeof fetch,
  });
  bindPair(client, config);

  return {
    kind: "recorded",
    config,
    client,
    describe: () =>
      `recorded transport — ${script.turns.length} scripted assistant turns, no network, no API key`,
    exchanges,
  };
}

// ---------------------------------------------------------------------------
// Local transport

/**
 * Refuse any redirect, and prove the body we are about to read came from the
 * host we addressed.
 *
 * ## — the hole this closes
 *
 * `fetch` defaults to `redirect: "follow"`. A 307 or 308 preserves the method
 * **and the body**, so a local server — compromised, misconfigured, or merely a
 * reverse proxy someone pointed elsewhere — could answer the request with
 * `Location: https://example.com/collect` and `fetch` would obligingly re-send
 * the entire investigation there: the system prompt, the alert payload, every
 * byte of verbatim cluster output, and the private-Forgejo runbook text the
 * docs tools returned. `assertLocalModelUrl` would never see that host, because
 * it validates the URL we *chose*, not the one the transfer *ended at*.
 *
 * Three defences, because each covers a different failure of the others:
 *
 *  1. `redirect: "manual"` at the call site, so no redirect is ever followed.
 *  2. This function, which treats a 3xx as a hard error rather than letting it
 *     fall through to the `!response.ok` branch as a merely unhelpful status —
 *     and which reports the `Location` it refused, because a redirect to a
 *     public host is an incident, not a hiccup.
 *  3. Re-validating `response.url` against the same local-only predicate. If a
 *     future runtime, an intercepting agent, or a change to the flag above ever
 *     causes a hop to happen anyway, the address the body actually came from is
 *     checked before a single byte of it is read.
 */
export function assertNoRedirect(response: Response, endpoint: URL): void {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    throw new TransportError(
      `the local inference server at ${endpoint.href} answered ${response.status} with a ` +
        `redirect${location === null ? "" : ` to ${location}`}. Redirects are refused, not ` +
        "followed: a 307/308 preserves the POST body, so following one would re-send the " +
        "entire investigation — system prompt, alert payload, verbatim cluster output and " +
        "private runbook text — to whatever host Location names. Nothing was forwarded. " +
        "Point LOCAL_MODEL_BASE_URL at the inference server directly rather than at a " +
        "proxy that redirects.",
    );
  }
  // `redirect: "manual"` leaves `response.url` as the request URL on every
  // runtime we support, so this is a tripwire rather than a routine check: it
  // only fires if something upstream of us followed a hop.
  const landed = response.url;
  if (typeof landed === "string" && landed !== "") {

    if (!isProvablyLocalUrl(landed)) {
      throw new TransportError(
        `the response body arrived from ${landed}, which is not a local address. The request ` +
          `was addressed to ${endpoint.href}, so the transfer was redirected despite ` +
          "redirect:manual. Refusing to read the body. Treat this as a possible exfiltration " +
          "attempt: the request that was already sent carried the full investigation.",
      );
    }
  }
}

/**
 * Read a response body, refusing it the moment it crosses `max` bytes.
 *
 * The previous code called `response.text()` and checked the length afterwards.
 * A chunked response with no `Content-Length` — which is what a streaming-capable
 * local server emits by default — was therefore fully buffered before the
 * ceiling was consulted, so the ceiling bounded what was *accepted* and not what
 * was *held*. A model in a repetition loop (the characteristic failure of a
 * small quantised model, and the reason the ceiling exists at all) could put
 * gigabytes through that path.
 *
 * This reads incrementally and aborts at the first chunk that crosses the line,
 * cancelling the stream so the server is not left writing into a socket nobody
 * is draining. Peak memory is bounded by `max` plus one chunk.
 */
export async function readBounded(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (body === null || body === undefined) {
    // No stream to bound (an empty body, or a Response built in-process).
    const text = await response.text();
    if (Buffer.byteLength(text) > max) {
      throw new TransportError(
        `the local server returned ${Buffer.byteLength(text)} bytes (ceiling ${max}). ` +
          "A response this size is a runaway generation, not a turn.",
      );
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > max) {
        throw new TransportError(
          `the local server's response crossed the ${max}-byte ceiling and was cut off ` +
            `mid-read (${total} bytes in). A response this size is a runaway generation, ` +
            "not a turn. The body was never fully buffered and the stream was cancelled.",
        );
      }
      chunks.push(value);
    }
  } finally {
    // Releases the socket whether we finished or bailed out.
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * An `Anthropic` client whose `fetch` translates to a local OpenAI-compatible
 * inference server.
 *
 * ## The tool-result gate is deliberately NOT applied here
 *
 * `assertToolResultsUsable` stops a recorded replay dead when the preceding
 * turn's tools failed, because a scripted report laid on top of failed tool
 * calls is a PASS that proves nothing — the fixture would have produced the
 * same words regardless.
 */
export function localTransport(configInput: Config = localConfig()): Transport {

  const config = frozenConfigSnapshot(configInput);
  const baseRaw = (config as Record<string, unknown>)["LOCAL_MODEL_BASE_URL"];
  if (typeof baseRaw !== "string" || baseRaw === "") {
    throw new TransportError(
      "localTransport needs LOCAL_MODEL_BASE_URL (e.g. http://127.0.0.1:11434/v1 for " +
        "Ollama, http://127.0.0.1:1234/v1 for LM Studio). No inference server is " +
        "configured, so there is nothing to translate to.",
    );
  }

  if (!isLocalEngine(config)) {
    const name = (config as Record<string, unknown>)["LOCAL_MODEL_NAME"];
    const triage = (config as Record<string, unknown>)["ANTHROPIC_TRIAGE_MODEL"];
    throw new TransportError(
      "refusing to build a local transport: this config is not in local-engine mode, so " +
        "the egress policy would hand the tools the unrestricted global fetch while " +
        "inference ran locally — investigation content could leave the LAN. " +
        `ANTHROPIC_TRIAGE_MODEL=${JSON.stringify(triage)} must equal ` +
        `LOCAL_MODEL_NAME=${JSON.stringify(name)} (and both LOCAL_MODEL_* must be set). ` +
        "Use localConfig(), which performs that substitution, or set the variables to match.",
    );
  }
  // Validated at config load; re-asserted here because this function is
  // exported and a caller may hand-build a Config.
  const base = assertLocalModelUrl(baseRaw);
  const endpoint = new URL(
    "chat/completions",
    base.href.endsWith("/") ? base.href : `${base.href}/`,
  );
  // Belt and braces: `new URL(relative, base)` cannot change the host, but the
  // cost of proving that at runtime is one call and the cost of being wrong is
  // the entire investigation leaving the LAN.
  assertLocalModelUrl(endpoint.href);

  for (const variable of EGRESS_URL_VARS) {
    const raw = (config as Record<string, unknown>)[variable];
    if (typeof raw !== "string" || raw === "") continue;
    try {
      checkEgressUrl(raw, variable);
    } catch (error) {
      throw new TransportError(
        `refusing to start a local run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  try {

    assertKubectlServerLocality(config);
  } catch (error) {
    throw new TransportError(
      `refusing to start a local run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const timeoutMs = Number(
    (config as Record<string, unknown>)["LOCAL_MODEL_TIMEOUT_MS"] ?? 600_000,
  );

  const exchanges: Exchange[] = [];
  let turnIndex = 0;

  let servedWindow: Extract<ContextWindowProbe, { outcome: "served" }> | null = null;
  // One set for the whole run —. See
  // `ToBetaMessageOptions.issuedToolCallIds` for what a per-response set cost.
  const issuedToolCallIds = new Set<string>();

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    // The SDK must have built a real Messages request, and the body must be one
    // the real API would accept. Both checks are shared verbatim with the
    // recorded transport: the point of the seam is that the request is real, and
    // that claim is worth no less when the reply comes from a local model.
    assertMessagesEndpoint(url, method);
    const request = parseMessagesRequest(init?.body);

    turnIndex += 1;
    // The raw body rather than the typed `request` above, because the bound must
    // cover EVERYTHING the payload carries — the system blocks and tool schemas
    // that `MessagesRequest` does not model, and the assistant prose, thinking
    // blocks and tool arguments that the per-turn check leaves out.
    assertRequestFitsServedWindow({
      payload: JSON.parse(String(init?.body ?? "null")) as unknown,
      probe: servedWindow,
      turn: turnIndex,
    });
    const chatRequest = toChatCompletionsRequest(request);

    let response: Response;
    try {
      // It also does not follow redirects at all, which preserves's
      // finding-1 fix by construction rather than by remembering the flag.
      response = await localFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(chatRequest),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TransportError(
        `the local inference server at ${endpoint.href} could not be reached (${reason}). ` +
          "Start it, or check LOCAL_MODEL_BASE_URL. The investigation payload was addressed " +
          `only to ${endpoint.origin}; redirects are refused, not followed, so no part of it ` +
          "was forwarded to another host.",
        // The ONE retryable failure in this transport: the socket never
        // delivered a response, so no control has spoken and re-dialling the
        // same pinned endpoint asks the same question again. Everything below
        // this point in the function has a RESPONSE in hand, and refusing it is
        // a decision — decisions are not retried.
        { retryable: true, cause: error },
      );
    }

    try { assertNoRedirect(response, endpoint); } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }

    const message = await assembleLocalStream(response, {
      allowance: chatRequest.max_tokens,
      model: chatRequest.model,
      turn: turnIndex,
      issuedToolCallIds,
      onToolCallIdCollision: (info) => {
        process.stderr.write(
          `[local transport] turn ${info.turn}: the server reused tool_call id ` +
            `${JSON.stringify(info.id)} from an earlier turn; re-issued as ` +
            `${info.replacement}. The model is emitting a malformed conversation — ` +
            "the call is preserved, but record this when ranking the model.\n",
        );
      },
    });

    // Populated exactly as the recorded transport populates it: the Anthropic
    // request the SDK built, and the Anthropic message handed back. So the
    // committed transcript carries the same audit detail on this path as on a
    // dry run — which `liveTransport` cannot offer, because it does not
    // intercept.
    exchanges.push({ turn: turnIndex, request, response: message });

    return new Response(JSON.stringify(message), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "request-id": `req_local_${turnIndex}`,
      },
    });
  };

  const client = newAnthropicClient({
    apiKey: "local-model-no-anthropic-key",
    maxRetries: 0,

    baseURL: ANTHROPIC_API_ORIGIN,
    fetch: fetchImpl as unknown as typeof fetch,
    // First, it makes the SDK's request deadline agree with the one the fetch
    // above already enforces via AbortSignal, instead of the SDK's own 600_000
    // default silently undercutting it.
    //
    // Second — and this is the point — `messages.js` consults
    // `calculateNonstreamingTimeout` ONLY when the client carries no explicit
    // timeout. That guard refuses any non-streaming request whose generation it
    // estimates at over ten minutes, which caps max_tokens at 21_333.
    // The guard is right about the real API, which cannot hold a non-streaming
    // connection that long. It is not right about a LAN server we dial
    // ourselves, with our own abort already on the fetch. Setting this skips the
    // guard for LOCAL runs only; the live client still carries no timeout and is
    // still protected by it.
    timeout: timeoutMs,
  });
  bindPair(client, config);

  return {
    kind: "local",
    config,
    client,

    describe: () =>
      `local transport — OpenAI-compatible endpoint ${endpoint.href}, model ` +
      `${config.ANTHROPIC_TRIAGE_MODEL} (no Anthropic API key). ${describeEgress(config)}`,
    exchanges,
    // the answer is also REMEMBERED here, in `servedWindow`, so the
    // wire itself can refuse a request that does not fit it. The probe is the
    // only thing on this path that knows the number, and a bound nothing below
    // the loop can see is a bound that arrives one turn too late.
    probeContextWindow: async () => {
      const probe = await probeOllamaContextWindow({
        baseUrl: base,
        model: config.ANTHROPIC_TRIAGE_MODEL,
        fetchImpl: (url, init) => localFetch(url, init),
        timeoutMs,
        // `/api/ps` lists only LOADED models, so a cold server knows nothing
        // about a window it has not allocated yet. One minimal completion makes
        // the model resident; it is the same load the first real turn would
        // have paid for, moved earlier so the answer exists before the run
        // commits to anything.
        warm: async () => {
          const response = await localFetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({
              model: config.ANTHROPIC_TRIAGE_MODEL,
              messages: [{ role: "user", content: "ok" }],
              max_tokens: 1,
              stream: true,
              stream_options: { include_usage: true },
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          await assembleLocalStream(response, {
            model: config.ANTHROPIC_TRIAGE_MODEL, turn: 0, allowance: 1, purpose: "warmup",
          });
        },
      });
      servedWindow = probe.outcome === "served" ? probe : null;
      return probe;
    },
  };
}

/**
 * Render an error together with its `cause` chain.
 *
 * ## Why this is needed at all
 *
 * The SDK catches anything thrown by the injected `fetch` and re-throws it as
 * `APIConnectionError`, whose message is the literal string **"Connection
 * error."** — with the original hung on `.cause`. Every diagnosis this
 * transport works hard to produce (the endpoint is unreachable; the model
 * emitted 5 MiB; the server said "model not loaded"; the tool arguments were
 * not JSON) therefore reaches an operator, through a CLI that prints
 * `error.message`, as those two words.
 */
export function describeTransportFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current) && parts.length < 6) {
    seen.add(current);
    parts.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (parts.length === 0) return String(error);
  // Drop the SDK's contentless wrapper when something more specific follows it.
  const meaningful = parts.filter((p, i) => !(i === 0 && p === "Connection error." && parts.length > 1));
  return meaningful.join("\n  caused by: ");
}

/**
 * The Config a local run uses.
 *
 * Two substitutions, both of them *config* rather than code — which is what
 * keeps "no mode flag below the seam" true:
 */
export function localConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const diagnostic = loadDiagnosticConfig(env);
  const name = diagnostic.LOCAL_MODEL_NAME;
  if (name === undefined || name === "") {
    throw new TransportError(
      "localTransport needs LOCAL_MODEL_NAME — the model id the local server serves " +
        "(`ollama list` / LM Studio's model panel). It is recorded in the report header " +
        "and the metering footer, so a run cannot be attributed without it.",
    );
  }
  const config = {
    ...diagnostic,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_TRIAGE_MODEL: name,
  } as Config;
  // Not the enforcement layer. `localTransport` and `runKubectl` each re-run the
  // same guard independently and are what make the property true; this is the
  // documented early belt, finally on the path it was documented for.
  assertKubeServerBelt(config as unknown as Record<string, unknown>);
  return config;
}
