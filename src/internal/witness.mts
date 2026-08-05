// internal/witness.mts — middleware witnessing over the utterance log.
//
// Every middleware audit log is a charged trace read over plain utterances.
// A recorded fact is a cell (subject —predicate→ object) with two evidence
// sides, but the bedrock admits no polarity: the truth side utters the
// cell's claim, and the falsity side utters the CONTRARY claim — its own
// claim of the contrary predicate (claim mark value `{ not: predicate }`),
// never a denial. Reads fold the utterances recorded at a cell back to a
// charge name: truth present iff the claim was uttered, falsity present iff
// the contrary claim was. Provenance never enters the kernel — testimony
// stays at the call site (request traces keep theirs at the trace layer).

import type { ChargeValueName, UtteranceCarrier } from "@red-cup-engineering/relating";
import { mark, utterance } from "../../../../../../../../../../../lenticule-science/services/semiotics-services-section/services/articulating-services-section/dist/lib/articulating/index.mjs";
import { chargeNameOfSides } from "./charge-names.mjs";

export class UtteranceLog {
  readonly #utterances: UtteranceCarrier[];

  constructor(utterances: readonly UtteranceCarrier[] = []) {
    this.#utterances = [...utterances];
  }

  get utterances(): readonly UtteranceCarrier[] {
    return Object.freeze([...this.#utterances]);
  }

  admit(...utterances: readonly UtteranceCarrier[]): UtteranceLog {
    this.#utterances.push(...utterances);
    return this;
  }
}

/** A cell address in middleware vocabulary: plain values, not yet terms. */
export type WitnessCell = Readonly<{
  subject: unknown;
  predicate: unknown;
  object: unknown;
}>;

/** Web-server's naming convention for the contrary predicate: the claim mark
 * value `{ not: predicate }`. A contrary fact is its own claim — there is no
 * denial in the bedrock. */
const contraryClaimValue = (predicate: unknown): Readonly<{ not: unknown }> =>
  Object.freeze({ not: predicate });

const contraryReading = (claimValue: unknown): { readonly not: unknown } | undefined => {
  if (typeof claimValue !== "object" || claimValue === null || Array.isArray(claimValue)) return undefined;
  const record = claimValue as { readonly not?: unknown };
  if (Object.keys(record).length !== 1 || record.not === undefined) return undefined;
  return record as { readonly not: unknown };
};

/** Whether an utterance claims the contrary predicate of its cell. */
export function isContraryUtterance(carrier: UtteranceCarrier): boolean {
  return contraryReading(carrier.claim.mark.value) !== undefined;
}

/** The utterances a bit-pair fact decodes to: the truth side utters the
 * cell's claim, the falsity side utters the contrary claim. */
export function factUtterances(
  cell: WitnessCell,
  sides: readonly [boolean, boolean],
): readonly UtteranceCarrier[] {
  const tokenMark = mark({ subject: cell.subject, object: cell.object });
  const out: UtteranceCarrier[] = [];
  if (sides[0]) out.push(utterance(tokenMark, mark(cell.predicate)));
  if (sides[1]) out.push(utterance(tokenMark, mark(contraryClaimValue(cell.predicate))));
  return out;
}

/** Admit a fact into the log. Accretive, chainable — the write half of the
 * old MemeStore.store. */
export function witness(
  log: UtteranceLog,
  cell: WitnessCell,
  sides: readonly [boolean, boolean],
): UtteranceLog {
  return log.admit(...factUtterances(cell, sides));
}

/** Fold utterances to a charge name: truth present iff any claim is uttered
 * plain, falsity present iff any contrary claim is uttered. Empty folds to
 * "absurd". */
export function chargeOfUtterances(utterances: Iterable<UtteranceCarrier>): ChargeValueName {
  let truth = false;
  let falsity = false;
  for (const carrier of utterances) {
    if (isContraryUtterance(carrier)) falsity = true;
    else truth = true;
    if (truth && falsity) break;
  }
  return chargeNameOfSides(truth, falsity);
}

/** The plain values at an utterance's cell, in middleware vocabulary. The
 * contrary claim reads back to the BASE predicate — the two opposed claims
 * address the same middleware fact. */
export function cellValues(carrier: UtteranceCarrier): WitnessCell {
  const tokenValue = carrier.token.mark.value;
  const pair = typeof tokenValue === "object" && tokenValue !== null && !Array.isArray(tokenValue)
    ? tokenValue as { readonly subject?: unknown; readonly object?: unknown }
    : undefined;
  const claimValue = carrier.claim.mark.value;
  const contrary = contraryReading(claimValue);
  return {
    subject: pair !== undefined && "subject" in pair ? pair.subject : tokenValue,
    predicate: contrary === undefined ? claimValue : contrary.not,
    object: pair !== undefined && "object" in pair ? pair.object : tokenValue,
  };
}

const valueCoincides = (left: unknown, right: unknown): boolean =>
  webAddressValueIdentity(left, right);

/** Downstream address identity for values web itself placed inside marks.
 * Relationality keeps marks opaque; this is only the web middleware's own
 * address vocabulary, used before values cross back into utterances. */
function webAddressValueIdentity(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => webAddressValueIdentity(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) =>
    key === rightKeys[index] && webAddressValueIdentity(leftRecord[key], rightRecord[key]));
}

/** Utterances whose middleware cell matches the given values (bedrock mark
 * coincidence), in admission order. Omitted fields match anything — the
 * partial-address scan. Both the plain and the contrary claim at a cell
 * match its address. */
export function recallWhere(log: UtteranceLog, where: Partial<WitnessCell>): readonly UtteranceCarrier[] {
  return log.utterances.filter((carrier) => {
    const values = cellValues(carrier);
    if ("subject" in where && !valueCoincides(values.subject, where.subject)) return false;
    if ("predicate" in where && !valueCoincides(values.predicate, where.predicate)) return false;
    if ("object" in where && !valueCoincides(values.object, where.object)) return false;
    return true;
  });
}

/** Recall a cell's utterances (plain and contrary claims), in admission order. */
export function recallCell(log: UtteranceLog, cell: WitnessCell): readonly UtteranceCarrier[] {
  return recallWhere(log, cell);
}

/** The charge currently at a cell — the read half of the old recall-and-fold. */
export function chargeAt(log: UtteranceLog, cell: WitnessCell): ChargeValueName {
  return chargeOfUtterances(recallCell(log, cell));
}
