// internal/hash.ts — SHA-1 and SHA-256 helpers for ETags and content addressing.
import { protocolDigestBytes, protocolDigestHex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/hash";

export function sha1(data: string | Buffer): Buffer {
  return protocolDigestBytes("sha1", data);
}

export function sha1hex(data: string | Buffer): string {
  return protocolDigestHex("sha1", data);
}

/** Strong ETag: quoted SHA-1 hex of body content. */
export function strongEtag(data: string | Buffer): string {
  return `"${sha1hex(data)}"`;
}

/** Generate a random UUID v4. */
export function uuid(): string {
  return crypto.randomUUID();
}
