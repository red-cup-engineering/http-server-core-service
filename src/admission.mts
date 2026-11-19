// admission.mts — the web tier's charge boundary over Metrologic's FOUR readings.
// The exported names are kept stable for the many middleware call sites:
// positive/negative bits are the truth/falsity evidence sides.

import type { ChargeValueName } from "@red-cup-engineering/metrologic/articulation/predicating/positing/valued";
import { chargeNameOfSides, chargeSidesOf } from "./internal/charge-names.mjs";

export type ChargeBearing = Readonly<{
  charge: Readonly<{
    value: readonly unknown[];
  }>;
}>;

export function chargeValueFromBits(positive: boolean, negative: boolean): ChargeValueName {
  return chargeNameOfSides(positive, negative);
}

export function chargeBits(value: ChargeValueName): readonly [boolean, boolean] {
  return chargeSidesOf(value);
}

export function chargeValueFromEvidence(items: Iterable<ChargeBearing>): ChargeValueName {
  let positive = false;
  let negative = false;
  for (const item of items) {
    positive ||= Boolean(item.charge.value[0]);
    negative ||= Boolean(item.charge.value[1]);
  }
  return chargeValueFromBits(positive, negative);
}
