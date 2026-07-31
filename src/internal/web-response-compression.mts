// internal/web-response-compression.ts — shared fetch Response content-coding decisions.
import { compressStream, supportedCompressionCodings } from "../compress.mjs";
import { isCompressible, negotiateEncoding, type Coding } from "@red-cup-engineering/computing-with-http/codecs/negotiation";
import { isEventStream } from "@red-cup-engineering/computing-with-http/codecs/sse";
import type { Readable } from "node:stream";

export type WebResponseCompressionOptions = {
  method?: string;
  acceptEncoding?: string | string[];
  range?: string | string[];
  codings?: readonly Coding[];
};

export type WebResponseCompressionPlan = {
  kind: "compress";
  coding: Exclude<Coding, "identity">;
} | { kind: "identity" } | { kind: "not-acceptable" };

export function bodyForbidden(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

export function planWebResponseCompression(
  status: number,
  headers: Record<string, string>,
  options: WebResponseCompressionOptions = {},
): WebResponseCompressionPlan {
  if (bodyForbidden(status)) return { kind: "identity" };

  const existingContentEncoding = knownCoding(headerValue(headers, "content-encoding"));
  if (existingContentEncoding) return accepted(existingContentEncoding, options);

  if (options.range !== undefined) return accepted("identity", options);
  if (headerValue(headers, "content-range") !== undefined) return accepted("identity", options);
  if (cacheControlHasNoTransform(headerValue(headers, "cache-control"))) return accepted("identity", options);

  const contentType = headerValue(headers, "content-type");
  if (!contentType || isEventStream(contentType) || !isCompressible(contentType)) return accepted("identity", options);

  const offered = offeredCodings(options.codings);
  const coding = negotiateEncoding(headerList(options.acceptEncoding), offered);
  if (!coding) return { kind: "not-acceptable" };
  if (coding === "identity") return { kind: "identity" };

  setHeader(headers, "content-encoding", coding);
  deleteHeader(headers, "content-length");
  appendVary(headers, "Accept-Encoding");
  return { kind: "compress", coding };
}

export function pipeCompressed(source: Readable, plan: WebResponseCompressionPlan): Readable {
  return plan.kind === "compress" ? source.pipe(compressStream(plan.coding)) : source;
}

export function writeContentCodingNotAcceptable(headers: Record<string, string>): void {
  setHeader(headers, "content-type", "text/plain; charset=utf-8");
  setHeader(headers, "content-length", String(Buffer.byteLength("Not Acceptable")));
  deleteHeader(headers, "content-encoding");
  appendVary(headers, "Accept-Encoding");
}

function offeredCodings(codings: readonly Coding[] | undefined): readonly Coding[] {
  if (!codings) return [...supportedCompressionCodings(), "identity"];
  return codings.includes("identity") ? codings : [...codings, "identity"];
}

function headerList(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function accepted(coding: Coding, options: WebResponseCompressionOptions): WebResponseCompressionPlan {
  return negotiateEncoding(headerList(options.acceptEncoding), [coding]) === null
    ? { kind: "not-acceptable" }
    : { kind: "identity" };
}

function knownCoding(value: string | undefined): Coding | null {
  const normalized = value?.split(",", 1)[0]?.trim().toLowerCase();
  return normalized === "br" || normalized === "gzip" || normalized === "deflate" || normalized === "zstd" || normalized === "identity"
    ? normalized
    : null;
}

function headerKey(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === normalized);
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = headerKey(headers, name);
  return key === undefined ? undefined : headers[key];
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  deleteHeader(headers, name);
  headers[name] = value;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const key = headerKey(headers, name);
  if (key !== undefined) delete headers[key]; // law-allow: delete-not-trace — header rewrite framing, not evidence
}

function appendVary(headers: Record<string, string>, value: string): void {
  const existing = headerValue(headers, "vary");
  if (!existing) {
    setHeader(headers, "vary", value);
    return;
  }
  const tokens = existing.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.some((token) => token === "*" || token.toLowerCase() === value.toLowerCase())) return;
  setHeader(headers, "vary", `${existing}, ${value}`);
}

function cacheControlHasNoTransform(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(",").some((part) => part.trim().toLowerCase() === "no-transform");
}

