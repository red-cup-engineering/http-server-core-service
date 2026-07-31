// admission.mts — the charge value boundary of the web tier, stated over
// @red-cup-engineering/animating trace carriers (and through them the relating topology bedrock).
// The exported names are kept stable for the many middleware call sites:
// positive/negative bits are the truth/falsity evidence sides.

import { chargeNameOfSides, chargeSidesOf } from "@red-cup-engineering/animating/becoming/doing/embodying";
import type { ChargeValueName } from "@red-cup-engineering/relating";

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
