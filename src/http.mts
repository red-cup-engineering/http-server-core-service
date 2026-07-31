// http.ts — HTTP transport mechanics: applying representations, CORS, SSE,
// body reading. The header-value representations themselves live in
// @red-cup-engineering/web-codecs-http.
import type { IncomingMessage, ServerResponse } from "node:http";
import { strongEtag } from "./internal/hash.mjs";
import { setTrailerHeader, writeResponseTrailers } from "./internal/trailers.mjs";
import {
  cacheControl,
  contentRange,
  httpDate,
  ifMatch,
  ifModifiedSince,
  ifNoneMatch,
  ifRange,
  ifUnmodifiedSince,
  multipartByterangesBody,
  multipartRangeBoundary,
  parseRanges,
  type CacheControl,
} from "@red-cup-engineering/computing-with-http/codecs/http";
import { negotiateEncoding, isCompressible } from "@red-cup-engineering/computing-with-http/codecs/negotiation";
import { compress, supportedCompressionCodings } from "./compress.mjs";
import type { Repr, Body, CorsOptions, SecurityHeaders, StrictTransportSecurity, ResponseTrailers } from "./types.mjs";
export {
  readBody,
  readFormBody,
  readJsonBody,
  readMultipartBody,
  readTextBody,
  type BodyParseOptions,
  type JsonBodyOptions,
  sse,
  type SseWriter,
} from "@red-cup-engineering/computing-with-http/app";

export { strongEtag };

export function ensureDateHeader(res: ServerResponse, now: Date | number = new Date()): void { // law-allow: wall-clock-as-data — Date header is HTTP protocol testimony (RFC 9110); caller may pass now
  if (!res.hasHeader("Date")) res.setHeader("Date", httpDate(now));
}

// ── CORS ─────────────────────────────────────────────────────────────────────────────────────

export type CorsPreflightDecision = {
  ok: boolean;
  status: number;
  reason?: "origin" | "method" | "headers" | "private-network";
};

function wildcardPattern(pattern: string): RegExp | null {
  if (!pattern.includes("*")) return null;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function originPatternAllowed(origin: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) return pattern.test(origin);
  if (pattern === "*") return true;
  const wildcard = wildcardPattern(pattern);
  return wildcard ? wildcard.test(origin) : pattern === origin;
}

export function corsOriginAllowed(req: IncomingMessage, opts: CorsOptions): boolean {
  const origin = String(req.headers["origin"] ?? "");
  if (!origin) return false;
  const { origins } = opts;
  if (!origins) return true;
  if (typeof origins === "function") return origins(origin, { req });
  return origins.some((pattern) => originPatternAllowed(origin, pattern));
}

function corsAllowedOrigin(req: IncomingMessage, opts: CorsOptions): string | null {
  const origin = String(req.headers["origin"] ?? "");
  if (!origin || !corsOriginAllowed(req, opts)) return null;
  const origins = opts.origins;
  const wildcard = Array.isArray(origins) && origins.includes("*");
  return wildcard && !opts.credentials ? "*" : origin;
}

function headerTokens(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

function requestedMethodAllowed(req: IncomingMessage, opts: CorsOptions): boolean {
  const method = String(req.headers["access-control-request-method"] ?? "").trim().toUpperCase();
  if (!method || !opts.methods?.length) return true;
  return opts.methods.map((item) => item.toUpperCase()).includes(method);
}

function requestedHeadersAllowed(req: IncomingMessage, opts: CorsOptions): boolean {
  if (!opts.headers?.length) return true;
  const allowed = new Set(opts.headers.map((item) => item.toLowerCase()));
  return headerTokens(req.headers["access-control-request-headers"])
    .every((item) => allowed.has(item.toLowerCase()));
}

function privateNetworkAllowed(req: IncomingMessage, opts: CorsOptions): boolean {
  return String(req.headers["access-control-request-private-network"] ?? "").toLowerCase() !== "true" ||
    opts.allowPrivateNetwork === true;
}

export function corsPreflightDecision(req: IncomingMessage, opts: CorsOptions): CorsPreflightDecision {
  const denyStatus = opts.preflightDenyStatus ?? 403;
  if (!corsOriginAllowed(req, opts)) return { ok: false, status: denyStatus, reason: "origin" };
  if (!requestedMethodAllowed(req, opts)) return { ok: false, status: 405, reason: "method" };
  if (!requestedHeadersAllowed(req, opts)) return { ok: false, status: denyStatus, reason: "headers" };
  if (!privateNetworkAllowed(req, opts)) return { ok: false, status: denyStatus, reason: "private-network" };
  return { ok: true, status: 204 };
}

export function applyCors(res: ServerResponse, req: IncomingMessage, opts: CorsOptions): void {
  const origin = corsAllowedOrigin(req, opts);
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  if (opts.credentials) res.setHeader("Access-Control-Allow-Credentials", "true");
  if (opts.expose?.length) res.setHeader("Access-Control-Expose-Headers", opts.expose.join(", "));
  appendVary(res, "Origin");
}

export function corsPreflight(req: IncomingMessage, res: ServerResponse, opts: CorsOptions, status = 204): void {
  appendVary(res, "Access-Control-Request-Method");
  appendVary(res, "Access-Control-Request-Headers");
  appendVary(res, "Access-Control-Request-Private-Network");
  if (opts.strictPreflight) {
    const decision = corsPreflightDecision(req, opts);
    if (!decision.ok) {
      res.writeHead(decision.status, { "content-type": "text/plain; charset=utf-8" })
        .end(decision.reason ? `CORS preflight denied: ${decision.reason}` : "CORS preflight denied");
      return;
    }
  }
  applyCors(res, req, opts);
  const reqMethod = req.headers["access-control-request-method"];
  const reqHeaders = req.headers["access-control-request-headers"];
  if (reqMethod) res.setHeader("Access-Control-Allow-Methods", opts.methods?.join(", ") ?? reqMethod);
  if (reqHeaders) res.setHeader("Access-Control-Allow-Headers", opts.headers?.join(", ") ?? reqHeaders);
  if (opts.allowPrivateNetwork && String(req.headers["access-control-request-private-network"] ?? "").toLowerCase() === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  if (opts.maxAge) res.setHeader("Access-Control-Max-Age", String(opts.maxAge));
  res.writeHead(status).end();
}

export function appendVary(res: ServerResponse, field: string): void {
  const existing = res.getHeader("Vary");
  const cur = existing ? String(existing) : "";
  const fields = cur ? cur.split(",").map((s) => s.trim()) : [];
  if (!fields.some((existingField) => existingField.toLowerCase() === field.toLowerCase())) {
    res.setHeader("Vary", [...fields, field].join(", "));
  }
}

// ── Cache-Control and security headers ───────────────────────────────────────────────────────

function seconds(name: string, value: number | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return String(value);
}

export function applyCacheControl(res: ServerResponse, policy: CacheControl | string | undefined): void {
  if (!policy || res.hasHeader("Cache-Control")) return;
  const value = cacheControl(policy);
  if (value) res.setHeader("Cache-Control", value);
}

const DEFAULT_SECURITY_HEADERS: Required<SecurityHeaders> = {
  contentSecurityPolicy: "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
  contentSecurityPolicyReportOnly: false,
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  contentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  frameOptions: "DENY",
  permissionsPolicy: "geolocation=(), microphone=(), camera=()",
  reportingEndpoints: false,
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
  crossOriginEmbedderPolicy: false,
  originAgentCluster: "?1",
  dnsPrefetchControl: "off",
  downloadOptions: "noopen",
  permittedCrossDomainPolicies: "none",
};

function hsts(value: StrictTransportSecurity | undefined): string | false {
  const hstsValue: StrictTransportSecurity = value === undefined
    ? DEFAULT_SECURITY_HEADERS.strictTransportSecurity
    : value;
  if (typeof hstsValue === "string" || hstsValue === false) return hstsValue;
  const maxAge = seconds("strictTransportSecurity.maxAge", hstsValue.maxAge ?? 31_536_000);
  const parts = [`max-age=${maxAge}`];
  if (hstsValue.includeSubDomains) parts.push("includeSubDomains");
  if (hstsValue.preload) parts.push("preload");
  return parts.join("; ");
}

function securityValue<K extends keyof SecurityHeaders>(
  headers: SecurityHeaders,
  key: K,
): Required<SecurityHeaders>[K] | SecurityHeaders[K] {
  return headers[key] === undefined ? DEFAULT_SECURITY_HEADERS[key] : headers[key];
}

function setHeaderUnlessDisabled(res: ServerResponse, name: string, value: string | false | undefined): void {
  if (value === false || value === undefined || res.hasHeader(name)) return;
  res.setHeader(name, value);
}

function reportingEndpoints(value: SecurityHeaders["reportingEndpoints"]): string | false | undefined {
  if (value === false || value === undefined || typeof value === "string") return value;
  return Object.entries(value)
    .map(([name, url]) => `${name}="${String(url).replace(/"/g, '\\"')}"`)
    .join(", ");
}

export function applySecurityHeaders(res: ServerResponse, policy: SecurityHeaders | true | undefined, nonce?: string): void {
  if (!policy) return;
  const headers = policy === true ? DEFAULT_SECURITY_HEADERS : policy;
  const csp = policy === true && nonce
    ? `default-src 'self'; style-src 'nonce-${nonce}'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'`
    : securityValue(headers, "contentSecurityPolicy");
  setHeaderUnlessDisabled(res, "Content-Security-Policy", csp);
  setHeaderUnlessDisabled(res, "Content-Security-Policy-Report-Only", securityValue(headers, "contentSecurityPolicyReportOnly"));
  setHeaderUnlessDisabled(res, "Strict-Transport-Security", hsts(headers.strictTransportSecurity));
  setHeaderUnlessDisabled(res, "X-Content-Type-Options", securityValue(headers, "contentTypeOptions"));
  setHeaderUnlessDisabled(res, "Referrer-Policy", securityValue(headers, "referrerPolicy"));
  setHeaderUnlessDisabled(res, "X-Frame-Options", securityValue(headers, "frameOptions"));
  setHeaderUnlessDisabled(res, "Permissions-Policy", securityValue(headers, "permissionsPolicy"));
  setHeaderUnlessDisabled(res, "Reporting-Endpoints", reportingEndpoints(securityValue(headers, "reportingEndpoints")));
  setHeaderUnlessDisabled(res, "Cross-Origin-Opener-Policy", securityValue(headers, "crossOriginOpenerPolicy"));
  setHeaderUnlessDisabled(res, "Cross-Origin-Resource-Policy", securityValue(headers, "crossOriginResourcePolicy"));
  setHeaderUnlessDisabled(res, "Cross-Origin-Embedder-Policy", securityValue(headers, "crossOriginEmbedderPolicy"));
  setHeaderUnlessDisabled(res, "Origin-Agent-Cluster", securityValue(headers, "originAgentCluster"));
  setHeaderUnlessDisabled(res, "X-DNS-Prefetch-Control", securityValue(headers, "dnsPrefetchControl"));
  setHeaderUnlessDisabled(res, "X-Download-Options", securityValue(headers, "downloadOptions"));
  setHeaderUnlessDisabled(res, "X-Permitted-Cross-Domain-Policies", securityValue(headers, "permittedCrossDomainPolicies"));
}

// ── Representation helpers ──────────────────────────────────────────────────────────────────

export type ReprOptions = Readonly<{
  status?: number;
  headers?: Record<string, string>;
  trailers?: ResponseTrailers;
  cacheControl?: CacheControl | string;
  security?: SecurityHeaders | true;
  etag?: string;
  lastModified?: Date;
}>;

export type JsonReprOptions = ReprOptions & Readonly<{
  type?: string;
  pretty?: boolean | number;
  newline?: boolean;
}>;

export type TextReprOptions = ReprOptions & Readonly<{
  type?: string;
}>;

export function jsonRepr(body: unknown, options: number | JsonReprOptions = {}): Repr {
  const opts = typeof options === "number" ? { status: options } : options;
  const indent = opts.pretty === true ? 2 : typeof opts.pretty === "number" ? opts.pretty : undefined;
  const serialized = JSON.stringify(body, null, indent) ?? "null";
  return repr({
    ...opts,
    type: opts.type ?? "application/json; charset=utf-8",
    body: opts.newline === false ? serialized : `${serialized}\n`,
  });
}

export function textRepr(body: string, options: number | TextReprOptions = {}): Repr {
  const opts = typeof options === "number" ? { status: options } : options;
  return repr({
    ...opts,
    type: opts.type ?? "text/plain; charset=utf-8",
    body,
  });
}

export function htmlRepr(body: string, options: number | TextReprOptions = {}): Repr {
  const opts = typeof options === "number" ? { status: options } : options;
  return repr({
    ...opts,
    type: opts.type ?? "text/html; charset=utf-8",
    body,
  });
}

export function emptyRepr(status = 204, options: ReprOptions = {}): Repr {
  return repr({ ...options, status });
}

function repr(options: ReprOptions & Readonly<{ type?: string; body?: Body }>): Repr {
  const out: Repr = {};
  if (options.status !== undefined) out.status = options.status;
  if (options.headers !== undefined) out.headers = options.headers;
  if (options.trailers !== undefined) out.trailers = options.trailers;
  if (options.type !== undefined) out.type = options.type;
  if (options.body !== undefined) out.body = options.body;
  if (options.cacheControl !== undefined) out.cacheControl = options.cacheControl;
  if (options.security !== undefined) out.security = options.security;
  if (options.etag !== undefined) out.etag = options.etag;
  if (options.lastModified !== undefined) out.lastModified = options.lastModified;
  return out;
}

// ── Send a Repr ───────────────────────────────────────────────────────────────────────────────

export async function send(req: IncomingMessage, res: ServerResponse, repr: Repr): Promise<void> {
  const { status = 200, headers = {}, body, type = "application/octet-stream" } = repr;

  ensureDateHeader(res);
  applyCacheControl(res, repr.cacheControl);
  applySecurityHeaders(res, repr.security);

  // RFC 9110 conditional requests: failed preconditions become 412 before
  // cache validators can turn safe methods into 304 responses.
  if (repr.etag) {
    res.setHeader("ETag", repr.etag);
    if (!ifMatch(req.headers["if-match"], repr.etag)) { res.writeHead(412).end(); return; }
  }
  if (repr.lastModified) {
    res.setHeader("Last-Modified", httpDate(repr.lastModified));
    if (!ifUnmodifiedSince(req.headers["if-unmodified-since"], repr.lastModified)) { res.writeHead(412).end(); return; }
  }
  if (repr.etag && ifNoneMatch(req.headers["if-none-match"], repr.etag)) {
    res.writeHead(req.method === "GET" || req.method === "HEAD" ? 304 : 412).end();
    return;
  }
  if (!repr.etag && repr.lastModified && ifModifiedSince(req.headers["if-modified-since"], repr.lastModified)) {
    res.writeHead(req.method === "GET" || req.method === "HEAD" ? 304 : 412).end();
    return;
  }

  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", type);

  // Buffer the body to apply compression and range
  if (!body) { res.writeHead(status).end(); return; }

  if (typeof body === "string" || Buffer.isBuffer(body)) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");

    // Range
    const ranges = ifRange(req.headers["if-range"], {
      ...(repr.etag !== undefined ? { etag: repr.etag } : {}),
      ...(repr.lastModified !== undefined ? { lastModified: repr.lastModified } : {}),
    })
      ? parseRanges(req.headers["range"], buf.length)
      : null;
    if (ranges === 416) {
      res.setHeader("Content-Range", contentRange(null, buf.length));
      res.writeHead(416).end();
      return;
    }
    if (ranges) {
      const coding = negotiateEncoding(req.headers["accept-encoding"] as string | undefined, ["identity"]);
      if (coding === null) {
        appendVary(res, "Accept-Encoding");
        res.writeHead(406, { "Content-Type": "text/plain; charset=utf-8" }).end(req.method === "HEAD" ? undefined : "Not Acceptable");
        return;
      }
      if (ranges.length > 1) {
        const boundary = multipartRangeBoundary(buf.length, ranges);
        const body = multipartByterangesBody(buf, ranges, type, boundary);
        res.setHeader("Content-Type", `multipart/byteranges; boundary=${boundary}`);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", body.length);
        res.writeHead(206).end(req.method === "HEAD" ? undefined : body);
        return;
      }
      const range = ranges[0]!;
      const slice = buf.slice(range.start, range.end + 1);
      res.setHeader("Content-Range", contentRange(range, buf.length));
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", slice.length);
      res.writeHead(206).end(req.method === "HEAD" ? undefined : slice);
      return;
    }

    // Full response with optional compression
    const compressible = isCompressible(type);
    const coding = negotiateEncoding(req.headers["accept-encoding"] as string | undefined, compressible ? [...supportedCompressionCodings(), "identity"] : ["identity"]);
    if (coding === null) {
      appendVary(res, "Accept-Encoding");
      res.writeHead(406, { "Content-Type": "text/plain; charset=utf-8" }).end(req.method === "HEAD" ? undefined : "Not Acceptable");
      return;
    }
    if (compressible) {
      appendVary(res, "Accept-Encoding");
      if (coding !== "identity") {
        const out = await compress(buf, coding);
        const trailers = req.method === "HEAD" ? undefined : repr.trailers;
        const hasTrailers = setTrailerHeader(res, trailers);
        res.setHeader("Content-Encoding", coding);
        if (!hasTrailers) res.setHeader("Content-Length", out.length);
        res.writeHead(status);
        endWithTrailers(res, req.method === "HEAD" ? undefined : out, trailers);
        return;
      }
    }
    const trailers = req.method === "HEAD" ? undefined : repr.trailers;
    const hasTrailers = setTrailerHeader(res, trailers);
    if (!hasTrailers) res.setHeader("Content-Length", buf.length);
    res.setHeader("Accept-Ranges", "bytes");
    res.writeHead(status);
    endWithTrailers(res, req.method === "HEAD" ? undefined : buf, trailers);
  } else {
    // Streaming body
    if (req.method === "HEAD") { res.writeHead(status).end(); return; }
    setTrailerHeader(res, repr.trailers);
    res.writeHead(status);
    await pipeBody(body, res, repr.trailers);
  }
}

function endWithTrailers(
  res: ServerResponse,
  chunk: Buffer | string | Uint8Array | undefined,
  trailers: ResponseTrailers | undefined,
): void {
  writeResponseTrailers(res, trailers);
  res.end(chunk);
}

function pipeBody(body: Body, res: ServerResponse, trailers: ResponseTrailers | undefined): Promise<void> {
  const finish = () => {
    writeResponseTrailers(res, trailers);
    res.end();
  };
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    return new Promise((resolve) => {
      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) { finish(); resolve(); return; }
          res.write(value);
          pump();
        }).catch(() => { res.end(); resolve(); });
      };
      pump();
    });
  } else if (typeof (body as NodeJS.ReadableStream).pipe === "function") {
    return new Promise((resolve) => {
      const stream = body as NodeJS.ReadableStream;
      stream.on("error", () => { res.end(); resolve(); });
      stream.on("end", () => { finish(); resolve(); });
      stream.pipe(res, { end: false });
    });
  } else {
    // async iterable
    return (async () => {
      try {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          res.write(chunk);
        }
        finish();
      } catch {
        res.end();
      }
    })();
  }
}
