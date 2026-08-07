// internal/hash.ts — SHA-1 and SHA-256 helpers for ETags and content addressing.
import { createHash } from "node:crypto";

export function sha256(data: string | Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha1(data: string | Buffer): Buffer {
  return createHash("sha1").update(data).digest();
}

export function sha1hex(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Strong ETag: quoted SHA-1 hex of body content. */
export function strongEtag(data: string | Buffer): string {
  return `"${sha1hex(data)}"`;
}

/** Generate a random UUID v4. */
export function uuid(): string {
  return crypto.randomUUID();
}
