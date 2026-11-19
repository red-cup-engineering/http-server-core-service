// internal/base64url.ts — RFC 4648 §5 unpadded base64url codec.
export function encode(input: Buffer | Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  return buf.toString("base64url");
}

export function decode(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

export const base64urlEncode = encode;
export const base64urlDecode = decode;
