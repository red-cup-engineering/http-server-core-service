import { knowledgeJoinReading, readingAs, readingOfSides, sidesOfReading } from "@red-cup-engineering/metrologic/four";
import type { ChargeValueName } from "@red-cup-engineering/metrologic/articulation/predicating/positing/valued";

export function chargeNameOfSides(truthPresent: boolean, falsityPresent: boolean): ChargeValueName {
  return readingOfSides("knowledge", truthPresent, falsityPresent);
}

export function chargeSidesOf(value: ChargeValueName): readonly [boolean, boolean] {
  return sidesOfReading(value) as readonly [boolean, boolean];
}

export function joinKnowledgeNames(names: Iterable<ChargeValueName>): ChargeValueName {
  let joined: ChargeValueName = "absurd";
  for (const name of names) joined = readingAs("knowledge", knowledgeJoinReading(joined, name));
  return joined;
}
