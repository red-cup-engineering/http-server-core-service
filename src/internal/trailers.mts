// internal/trailers.ts - HTTP response trailer helpers.
import type { ServerResponse } from "node:http";
import type { ResponseTrailers, ResponseTrailerValue } from "../types.mjs";

type TrailerSource = Headers | ResponseTrailers;
type TrailerBearingResponse = Response & {
  trailers?: TrailerSource | Promise<TrailerSource>;
};

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_TRAILER_NAMES = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-range",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function headerEntries(trailers: ResponseTrailers): Array<[string, ResponseTrailerValue]> {
  return Object.entries(trailers).filter(([name]) => {
    const normalized = name.trim().toLowerCase();
    return TOKEN.test(name) && !FORBIDDEN_TRAILER_NAMES.has(normalized);
  });
}

function headersToTrailers(headers: Headers): ResponseTrailers {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) out[name] = value;
  return out;
}

function trailerSourceToTrailers(source: TrailerSource | undefined): ResponseTrailers | undefined {
  if (source === undefined) return undefined;
  return source instanceof Headers ? headersToTrailers(source) : source;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === "function";
}

function trailerHeaderValue(trailers: ResponseTrailers | undefined, existing?: string): string | undefined {
  const names = headerEntries(trailers ?? {}).map(([name]) => name);
  if (!names.length) return existing;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...(existing?.split(",") ?? []), ...names]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged.join(", ");
}

function stringifyTrailerValue(value: ResponseTrailerValue): string {
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

export function applyTrailerHeader(headers: Record<string, string>, trailers: ResponseTrailers | undefined): boolean {
  const value = trailerHeaderValue(trailers, headers.trailer ?? headers.Trailer);
  if (!value) return false;
  delete headers["content-length"]; // law-allow: delete-not-trace — Content-Length must not accompany trailers; protocol framing, not evidence
  delete headers["Content-Length"]; // law-allow: delete-not-trace — Content-Length must not accompany trailers; protocol framing, not evidence
  headers.trailer = value;
  return true;
}

export function setTrailerHeader(res: ServerResponse, trailers: ResponseTrailers | undefined): boolean {
  const existing = res.getHeader("Trailer");
  const existingValue = Array.isArray(existing) ? existing.join(", ") : existing === undefined ? undefined : String(existing);
  const value = trailerHeaderValue(trailers, existingValue);
  if (!value) return false;
  res.removeHeader("Content-Length");
  res.setHeader("Trailer", value);
  return true;
}

export function writeResponseTrailers(res: ServerResponse, trailers: ResponseTrailers | undefined): void {
  const out: Record<string, string> = {};
  for (const [name, value] of headerEntries(trailers ?? {})) out[name] = stringifyTrailerValue(value);
  if (!Object.keys(out).length) return;
  try {
    res.addTrailers(out);
  } catch {}
}

export function immediateResponseTrailers(response: Response): ResponseTrailers | undefined {
  const source = (response as TrailerBearingResponse).trailers;
  if (source === undefined || isPromise(source)) return undefined;
  return trailerSourceToTrailers(source);
}

export async function resolveResponseTrailers(response: Response): Promise<ResponseTrailers | undefined> {
  const source = (response as TrailerBearingResponse).trailers;
  if (source === undefined) return undefined;
  return trailerSourceToTrailers(isPromise(source) ? await source : source);
}
