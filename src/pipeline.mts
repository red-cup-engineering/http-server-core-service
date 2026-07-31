// pipeline.ts — the settling request pipeline.
//
// Each request is a RequestTrace. Middleware strategies append trace entries. The routing admission
// settles the trace: potential = matched resource admitted; active = denied (4xx); stable =
// contradiction held (500, not thrown); absurd = no resource matched (404).
//
// The pipeline is the only place that writes to res — handlers receive a live Context and
// write directly. Hooks (onRequest, onResponse, onError) are extension points.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App, Context, Middleware, Resource } from "./types.mjs";
import type { RequestTrace, RequestTraceEntry } from "./request.mjs";
import { traceRequest, appendEntries, claimOf } from "./request.mjs";
import { appendVary, applyCacheControl, applyCors, applySecurityHeaders, corsPreflight, ensureDateHeader, send } from "./http.mjs";
import { sendWebResponse } from "./internal/web-bridge.mjs";
import {
  routeAdmissionReport,
  routeAllowHeader,
  routeMethodAllowed,
  type RouteAdmissionReport,
} from "./route-admission.mjs";
import {
  httpProblem,
  problemFromError,
  resolveProblemInstance,
  sendProblem,
  type ProblemResponseOptions,
} from "./problem.mjs";

// ── Context factory ───────────────────────────────────────────────────────────────────────────

export function contextFor(req: IncomingMessage, res: ServerResponse, app: App): Context {
  const trace = traceRequest(req);
  const raw = req.url ?? "/";
  const base = requestBase(req, app);
  const target = requestTarget(raw);
  const url = (() => { try { return new URL(target, base); } catch { return new URL("/", base); } })();
  const signal = requestAbortSignal(req, res);
  const nonce = randomBytes(16).toString("base64url");
  return {
    req, res, app, url,
    params: {},
    locals: { ...(app.locals ?? {}) },
    nonce,
    signal,
    trace,
    startedAt: Date.now(), // law-allow: wall-clock-as-data — startedAt is duration-telemetry testimony, not ordering
  };
}

function requestAbortSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  // Node.js v24+ adds IncomingMessage.signal, but it aborts on normal req.close
  // (after body fully read), not only on premature client disconnect. Propagating
  // it would abort ctx.signal the moment the request body ends, which breaks
  // any middleware (e.g. proxyPass) that still needs to write a response. Genuine
  // client-disconnect aborts are covered by res.once("close") below.
  let completed = false;
  const abort = (reason: string) => {
    if (!completed && !controller.signal.aborted) controller.abort(new Error(reason));
  };
  res.once("finish", () => { completed = true; });
  res.once("close", () => abort("response closed before completion"));
  res.once("error", () => abort("response stream error"));
  req.once("aborted", () => abort("request aborted by client"));
  req.once("error", () => abort("request stream error"));
  // A bridged WHATWG Request (appToFetch) has no socket to emit close/aborted;
  // its cancellation arrives as an explicit upstream signal. Distinct property,
  // NOT req.signal — see the IncomingMessage.signal caveat above.
  const upstream = (req as { webAbortSignal?: unknown }).webAbortSignal;
  if (upstream instanceof AbortSignal) {
    if (upstream.aborted) abort("request aborted upstream");
    else upstream.addEventListener("abort", () => abort("request aborted upstream"), { once: true });
  }
  return controller.signal;
}

function requestTarget(raw: string): string {
  try {
    const absolute = new URL(raw);
    return `${absolute.pathname}${absolute.search}${absolute.hash}`;
  } catch {
    return raw;
  }
}

function requestBase(req: IncomingMessage, app: App): string {
  const configured = absoluteHttpBase(app.base);
  if (configured) return configured;

  const forwarded = app.trustProxy ? forwardedAuthority(req) : {};
  const proto = forwarded.proto ?? directProtocol(req);
  const host = forwarded.host ?? firstHeaderValue(req.headers.host) ?? "localhost";
  return safeOrigin(proto, host);
}

function absoluteHttpBase(base: string | undefined): string | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  return null;
}

function forwardedAuthority(req: IncomingMessage): { proto?: string; host?: string } {
  const forwarded = parseForwarded(firstHeaderValue(req.headers.forwarded));
  const proto = forwarded.proto ?? firstHeaderValue(req.headers["x-forwarded-proto"]);
  const host = forwarded.host ?? firstHeaderValue(req.headers["x-forwarded-host"]);
  return {
    ...(proto !== undefined ? { proto } : {}),
    ...(host !== undefined ? { host } : {}),
  };
}

function parseForwarded(value: string | undefined): { proto?: string; host?: string } {
  if (!value) return {};
  const first = value.split(",")[0] ?? "";
  const out: { proto?: string; host?: string } = {};
  for (const part of first.split(";")) {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    if (key !== "proto" && key !== "host") continue;
    const rawValue = rest.join("=").trim();
    const unquoted = rawValue.startsWith("\"") && rawValue.endsWith("\"")
      ? rawValue.slice(1, -1).replace(/\\(["\\])/g, "$1")
      : rawValue;
    if (key === "proto") out.proto = unquoted;
    if (key === "host") out.host = unquoted;
  }
  return out;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  const first = text?.split(",")[0]?.trim();
  return first || undefined;
}

function joinedHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

function directProtocol(req: IncomingMessage): string {
  return (req.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
}

function safeOrigin(proto: string, host: string): string {
  const protocol = proto.trim().toLowerCase() === "https" ? "https" : "http";
  const trimmedHost = host.trim();
  try {
    return new URL(`${protocol}://${trimmedHost}/`).href;
  } catch {
    return `${protocol}://localhost/`;
  }
}

// ── Resource matching ─────────────────────────────────────────────────────────────────────────

function matchResource(resource: Resource, path: string, ctx: Context): Record<string, string> | false {
  const { match } = resource;
  if (typeof match === "function") {
    const result = match(path, ctx);
    if (!result) return false;
    return typeof result === "object" ? result : {};
  }
  if (match instanceof RegExp) {
    const m = match.exec(path);
    return m ? { ...m.groups } : false;
  }
  // String: exact or pattern with :param segments
  if (!match.includes(":")) return match === path ? {} : false;
  const parts = match.split("/");
  const pathParts = path.split("/");
  if (parts.length !== pathParts.length) return false;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    const pp = pathParts[i] ?? "";
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(pp);
    else if (p !== pp) return false;
  }
  return params;
}

function resourceRoute(resource: Resource): string {
  if (resource.route) return resource.route;
  if (typeof resource.match === "string") return resource.match;
  if (resource.match instanceof RegExp) return resource.match.toString();
  return "function";
}

function exposeMatchedResource(ctx: Context, resource: Resource, params: Record<string, string>): void {
  const route = resourceRoute(resource);
  ctx.resource = resource;
  ctx.route = route;
  ctx.routeTemplate = route;
  ctx.matchedRoute = route;
  Object.assign(ctx.params, params);
  if (resource.id !== undefined) ctx.routeId = resource.id;
  if (resource.name !== undefined) ctx.routeName = resource.name;
}

function projectRouteAdmission(ctx: Context, report: RouteAdmissionReport): void {
  const resource = ctx.resource;
  if (resource?.produces?.length) appendVary(ctx.res, "Accept");
  if (resource?.languages?.length) appendVary(ctx.res, "Accept-Language");
  if (report.negotiatedType !== undefined) ctx.negotiatedType = report.negotiatedType;
  if (report.negotiatedLanguage !== undefined) {
    ctx.negotiatedLanguage = report.negotiatedLanguage;
    ctx.res.setHeader("Content-Language", report.negotiatedLanguage);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────────────────────

export function handler(app: App): (req: IncomingMessage, res: ServerResponse) => void {
  return function (req: IncomingMessage, res: ServerResponse) {
    void handle(app, req, res);
  };
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = contextFor(req, res, app);
  const problemOptions = appProblemOptions(app);
  let responseHookCalled = false;
  const fireOnResponse = async (): Promise<void> => {
    if (responseHookCalled) return;
    responseHookCalled = true;
    await app.onResponse?.(ctx);
  };
  ensureDateHeader(res);
  applyCacheControl(res, app.cacheControl);
  applySecurityHeaders(res, app.security, ctx.nonce);

  try {
    // onRequest hook
    if (app.onRequest) {
      const result = await app.onRequest(ctx);
      if (result === true) { await fireOnResponse(); return; }
      if (await sendReturnedResponse(ctx, result)) {
        await fireOnResponse();
        return;
      }
    }

    // CORS preflight
    if (req.method === "OPTIONS" && app.cors) {
      corsPreflight(req, res, app.cors);
      return;
    }
    if (app.cors) applyCors(res, req, app.cors);

    // Run middleware strategies and collect trace entries.
    let trace = ctx.trace;
    const appMiddlewareResult = await runMiddlewares(ctx, app.middlewares ?? [], trace);
    if (appMiddlewareResult.terminal) {
      await fireOnResponse();
      return;
    }
    trace = appMiddlewareResult.trace;

    // Find matching resource
    const path = ctx.url.pathname;
    let foundResource: Resource | null = null;
    let params: Record<string, string> = {};
    for (const resource of app.resources ?? []) {
      const m = matchResource(resource, path, ctx);
      if (m !== false) { foundResource = resource; params = m; break; }
    }
    if (foundResource) exposeMatchedResource(ctx, foundResource, params);

    if (foundResource && req.method === "OPTIONS" && foundResource.methods) {
      const allow = routeAllowHeader(foundResource);
      if (allow) res.setHeader("Allow", allow);
      res.writeHead(204).end();
      return;
    }

    // Settle the request trace through a pure route admission report.
    const accept = joinedHeaderValue(req.headers.accept);
    const acceptLanguage = joinedHeaderValue(req.headers["accept-language"]);
    const admission = routeAdmissionReport({
      trace,
      resource: foundResource,
      method: claimOf(trace, "method") ?? req.method ?? "GET",
      ...(accept !== undefined ? { accept } : {}),
      ...(acceptLanguage !== undefined ? { acceptLanguage } : {}),
    });
    projectRouteAdmission(ctx, admission);
    const settled = admission.settled;

    if (settled.value === "absurd") {
      if (await maybeSendProblem(ctx, 404, "Not Found", problemOptions)) return;
      res.writeHead(404).end("Not Found");
    } else if (settled.value === "active") {
      const method = claimOf(trace, "method") ?? "GET";
      const allow = admission.allow;
      if (foundResource && admission.denial === "method" && !routeMethodAllowed(foundResource, method)) {
        if (allow) res.setHeader("Allow", allow);
        if (await maybeSendProblem(ctx, 405, "Method Not Allowed", problemOptions, allow ? {
          headers: { Allow: allow },
        } : undefined)) return;
        res.writeHead(405).end("Method Not Allowed");
      } else if (admission.denial === "accept") {
        appendVary(res, "Accept");
        if (await maybeSendProblem(ctx, 406, "Not Acceptable", problemOptions)) return;
        res.writeHead(406, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Acceptable");
      } else if (admission.denial === "accept-language") {
        appendVary(res, "Accept-Language");
        if (await maybeSendProblem(ctx, 406, "Not Acceptable", problemOptions)) return;
        res.writeHead(406, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Acceptable");
      } else {
        if (await maybeSendProblem(ctx, 403, "Forbidden", problemOptions)) return;
        res.writeHead(403).end("Forbidden");
      }
    } else if (settled.value === "stable") {
      // Contradiction held — surface evidence, not a thrown error
      if (problemOptions && !res.headersSent) {
        const instance = resolveProblemInstance(ctx, problemOptions);
        await sendProblem(req, res, httpProblem(500, "Contradicted Request Evidence", {
          type: "urn:561-group:web-server:problem:contradicted-request",
          extensions: { evidence: settled.section.contradicted },
          ...(instance !== undefined ? { instance } : {}),
        }), problemOptions);
        return;
      }
      res.writeHead(500).end(JSON.stringify({ error: "contradicted", evidence: settled.section.contradicted }));
    } else {
      // potential — invoke resource handler
      const resourceMiddlewareResult = await runMiddlewares(ctx, foundResource!.middlewares ?? [], settled.trace);
      if (resourceMiddlewareResult.terminal) {
        await fireOnResponse();
        return;
      }
      ctx.trace = resourceMiddlewareResult.trace;
      await sendHandlerResult(ctx, await foundResource!.handler(ctx));
    }
  } catch (err) {
    if (app.onError) {
      try {
        const result = await app.onError(err, ctx);
        if (result === true || res.headersSent || res.writableEnded) return;
        if (await sendReturnedResponse(ctx, result)) return;
      } catch { /* fall through */ }
    }
    if (problemOptions && !res.headersSent) {
      const source = problemFromError(err, problemOptions);
      const instance = resolveProblemInstance(ctx, problemOptions) ?? source.instance;
      await sendProblem(req, res, instance === source.instance ? source : httpProblem(source.status, source.title, {
        type: source.type,
        headers: source.headers,
        extensions: source.extensions,
        ...(source.detail !== undefined ? { detail: source.detail } : {}),
        ...(instance !== undefined ? { instance } : {}),
        cause: err,
      }), problemOptions);
      return;
    }
    if (!res.headersSent) res.writeHead(500).end("Internal Server Error");
  } finally {
    if (res.writableEnded) await fireOnResponse();
  }
}

type MiddlewareRunResult =
  | { readonly terminal: true }
  | { readonly terminal: false; readonly trace: RequestTrace };

async function runMiddlewares(
  ctx: Context,
  middlewares: readonly Middleware[],
  initial: RequestTrace,
): Promise<MiddlewareRunResult> {
  let trace = initial;
  ctx.trace = trace;
  for (const middleware of middlewares) {
    const result = await middleware(ctx);
    if (result === true) return { terminal: true };
    if (Array.isArray(result)) {
      if (result.length > 0) {
        trace = appendEntries(trace, result as RequestTraceEntry[]);
        ctx.trace = trace;
      }
      continue;
    }
    if (await sendReturnedResponse(ctx, result)) return { terminal: true };
  }
  return { terminal: false, trace };
}

async function sendHandlerResult(ctx: Context, result: unknown): Promise<void> {
  await sendReturnedResponse(ctx, result);
}

async function sendReturnedResponse(ctx: Context, result: unknown): Promise<boolean> {
  if (result === undefined || result === null || ctx.res.headersSent || ctx.res.writableEnded) return false;
  if (result === false) return false;
  if (result instanceof Response) {
    await sendWebResponse(ctx.res, result, {
      ...(ctx.req.method === undefined ? {} : { method: ctx.req.method }),
      ...(ctx.req.headers["accept-encoding"] === undefined ? {} : { acceptEncoding: ctx.req.headers["accept-encoding"] }),
      ...(ctx.req.headers.range === undefined ? {} : { range: ctx.req.headers.range }),
    });
    return true;
  }
  if (isRepr(result)) {
    await send(ctx.req, ctx.res, result);
    return true;
  }
  throw new TypeError("request stage returned an unsupported response value");
}

function isRepr(value: unknown): value is Parameters<typeof send>[2] {
  return typeof value === "object" && value !== null && (
    "body" in value ||
    "status" in value ||
    "headers" in value ||
    "type" in value ||
    "etag" in value ||
    "lastModified" in value ||
    "cacheControl" in value ||
    "security" in value
  );
}

function appProblemOptions(app: App): ProblemResponseOptions | null {
  if (app.problems === true) return {};
  if (!app.problems) return null;
  return app.problems as ProblemResponseOptions;
}

async function maybeSendProblem(
  ctx: Context,
  status: number,
  title: string,
  options: ProblemResponseOptions | null,
  extra?: { headers?: Readonly<Record<string, string>> },
): Promise<boolean> {
  if (!options || ctx.res.headersSent) return false;
  const instance = resolveProblemInstance(ctx, options);
  await sendProblem(ctx.req, ctx.res, httpProblem(status, title, {
    ...(instance !== undefined ? { instance } : {}),
    ...(extra?.headers !== undefined ? { headers: extra.headers } : {}),
  }), options);
  return true;
}
