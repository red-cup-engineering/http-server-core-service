// Type declarations for SignCell's JavaScript utterance constructors.
declare module "@red-cup-engineering/signcell" {
  export function mark(value: unknown): import("./signcell-utterance.mjs").UtteranceMark;
  export function utterance(
    token: import("./signcell-utterance.mjs").UtteranceMark,
    claim: import("./signcell-utterance.mjs").UtteranceMark,
  ): import("./signcell-utterance.mjs").UtteranceCarrier;
}
