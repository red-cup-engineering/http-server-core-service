import type { ChargeValueName } from "@red-cup-engineering/relating";

const sides = Object.freeze({ absurd: [false, false], potential: [true, false], active: [false, true], stable: [true, true] } as const);

export function chargeNameOfSides(truthPresent: boolean, falsityPresent: boolean): ChargeValueName {
  if (truthPresent) return falsityPresent ? "stable" : "potential";
  return falsityPresent ? "active" : "absurd";
}

export function joinKnowledgeNames(names: Iterable<ChargeValueName>): ChargeValueName {
  let truth = false; let falsity = false;
  for (const name of names) { const pair = sides[name]; truth ||= pair[0]; falsity ||= pair[1]; }
  return chargeNameOfSides(truth, falsity);
}
