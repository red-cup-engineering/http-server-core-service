import { mark as signCellMark, utterance as signCellUtterance } from "@red-cup-engineering/signcell";

export type UtteranceMark = Readonly<{ kind: "utterance.mark"; value: unknown }>;

export type UtteranceCarrier = Readonly<{
  kind: "utterance.carrier";
  token: Readonly<{ kind: "utterance.token"; hand: "left"; mark: UtteranceMark }>;
  claim: Readonly<{ kind: "utterance.claim"; hand: "right"; mark: UtteranceMark }>;
}>;

export const mark: (value: unknown) => UtteranceMark = signCellMark;
export const utterance: (token: UtteranceMark, claim: UtteranceMark) => UtteranceCarrier = signCellUtterance;
