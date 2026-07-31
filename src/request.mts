// request.mts — the HTTP request as a charged trace.
//
// Each incoming request is cast to a RequestTrace whose entries record method,
// URL, headers, and socket metadata. Middleware strategies append further
// entries. Admission layers project their judgments into the trace; settlement
// is the knowledge join of the judgments, and the whole trace utters bedrock
// utterances through @red-cup-engineering/animating. Judgment charge values are data at the
// trace layer — they never re-enter bedrock admission. No service runs here:
// founding a world from the utterances is the caller's explicit induction.

import type { IncomingMessage } from "node:http";
import { mark, utterance, type ChargeValueName, type UtteranceCarrier } from "@red-cup-engineering/relating";
import { joinKnowledgeNames } from "@red-cup-engineering/animating/becoming/doing/embodying";

export type RequestTraceEntry = Readonly<{
  e: unknown;
  a: string;
  v: unknown;
  t: unknown;
}>;

export type RequestTrace = Readonly<{
  kind: "web-server.request-trace";
  id: string;
  entries: readonly RequestTraceEntry[];
}>;

export type RequestAdmissionJudgment = Readonly<{
  name: string;
  value: ChargeValueName;
  reason: string;
  path: string;
}>;

export type TraceEntry = Readonly<{
  subject: ReturnType<typeof mark>;
  predicate: ReturnType<typeof mark>;
  object: ReturnType<typeof mark>;
  provenance: unknown;
}>;

export type JudgmentSettlement = Readonly<{
  kind: "animating.trace.judgment-settlement";
  value: ChargeValueName;
  judgments: readonly RequestAdmissionJudgment[];
  stableJudgments: readonly RequestAdmissionJudgment[];
}>;

export type RequestTraceSettlement = Readonly<{
  kind: "web-server.request-settlement";
  trace: RequestTrace;
  value: ChargeValueName;
  ready: boolean;
  denied: boolean;
  contradicted: boolean;
  unsettled: boolean;
  judgments: readonly RequestAdmissionJudgment[];
  settlement: JudgmentSettlement;
  utterances: readonly UtteranceCarrier[];
  section: Readonly<{
    contradicted: readonly RequestAdmissionJudgment[];
  }>;
}>;

let reqCounter = 0;

/** Convert an IncomingMessage to a RequestTrace. The trace id becomes the request identity. */
export function traceRequest(req: IncomingMessage): RequestTrace {
  const id = `req-${++reqCounter}`;
  const t = String(Date.now()); // law-allow: wall-clock-as-data — t is witness testimony on trace entries; entry order is append order, id is the counter ordinal

  const entries: RequestTraceEntry[] = [
    { e: id, a: "method", v: String(req.method ?? "GET").toUpperCase(), t },
    { e: id, a: "url", v: String(req.url ?? "/"), t },
    { e: id, a: "http-version", v: req.httpVersion, t },
    { e: id, a: "remote-addr", v: String((req.socket as { remoteAddress?: string }).remoteAddress ?? ""), t },
  ];

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    entries.push({ e: id, a: `header.${key.toLowerCase()}`, v: Array.isArray(value) ? value.join(", ") : String(value), t });
  }

  return Object.freeze({ kind: "web-server.request-trace" as const, id, entries: Object.freeze(entries) });
}

/** Read the most recent value of a claim from a request trace. */
export function claimOf(trace: RequestTrace, claim: string): string | null {
  for (let i = trace.entries.length - 1; i >= 0; i--) {
    const entry = trace.entries[i]!;
    if (String(entry.e) === trace.id && entry.a === claim) {
      return String(entry.v);
    }
  }
  return null;
}

/** Read all values of a claim (e.g. multiple "middleware.tag" entries). */
export function allClaims(trace: RequestTrace, claim: string): string[] {
  const out: string[] = [];
  for (const entry of trace.entries) {
    if (String(entry.e) === trace.id && entry.a === claim) out.push(String(entry.v));
  }
  return out;
}

/** Append trace entries to a request trace (returns a new trace). */
export function appendEntries(trace: RequestTrace, entries: readonly RequestTraceEntry[]): RequestTrace {
  return Object.freeze({ ...trace, entries: Object.freeze([...trace.entries, ...entries]) });
}

function traceEntryOf(entry: RequestTraceEntry): TraceEntry {
  return {
    subject: mark(String(entry.e)),
    predicate: mark(entry.a),
    object: mark(String(entry.v)),
    provenance: entry.t,
  };
}

function judgmentEntry(trace: RequestTrace, judgment: RequestAdmissionJudgment): TraceEntry {
  return {
    subject: mark(trace.id),
    predicate: mark(`judgment:${judgment.name}`),
    object: mark(judgment.path),
    provenance: judgment.reason,
  };
}

function settleJudgments(judgments: readonly RequestAdmissionJudgment[]): JudgmentSettlement {
  const value = joinKnowledgeNames(judgments.map((judgment) => judgment.value));
  return Object.freeze({
    kind: "animating.trace.judgment-settlement" as const,
    value,
    judgments,
    stableJudgments: Object.freeze(judgments.filter((judgment) => judgment.value === "stable")),
  });
}

function utterTrace(entries: readonly TraceEntry[]): readonly UtteranceCarrier[] {
  return Object.freeze(entries.map((entry) => utterance(
    mark(Object.freeze({
      subject: entry.subject.value,
      object: entry.object.value,
    })),
    entry.predicate,
  )));
}

export function settleRequestTrace(
  trace: RequestTrace,
  judgments: readonly RequestAdmissionJudgment[],
): RequestTraceSettlement {
  const settlement = settleJudgments(judgments);
  const utterances = utterTrace([
    ...trace.entries.map(traceEntryOf),
    ...judgments.map((judgment) => judgmentEntry(trace, judgment)),
  ]);
  return Object.freeze({
    kind: "web-server.request-settlement" as const,
    trace,
    value: settlement.value,
    ready: settlement.value === "potential",
    denied: settlement.value === "active",
    contradicted: settlement.value === "stable",
    unsettled: settlement.value === "absurd",
    judgments,
    settlement,
    utterances,
    section: Object.freeze({
      contradicted: settlement.stableJudgments,
    }),
  });
}
