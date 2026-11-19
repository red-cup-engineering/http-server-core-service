// mount-app.mts — mount a whole App under a path prefix, inside one App.
//
// `mergeApps` composes apps that all share the root path space; `mount`/
// `mountApp` adapt @red-cup-engineering/web-topology described resources. Neither lets one
// App host another App at a sub-path. This does: `mountAt("/module", inner)`
// returns an App whose resources answer under `/module/*`, with the prefix
// stripped before the inner app sees the request — so the inner app, written
// to serve `/`, `/graph.svg`, `/packages/:name` at a root, serves them under
// the prefix without knowing it has moved.
//
// This is the WordPress/Odoo "one site, many modules" shape on the web-server
// pipeline: ops.561.group is ONE App on ONE port whose `/` is a launcher
// and whose subpaths are mounted module Apps, composed with mergeApps. No
// second process, no second host, no reverse proxy.
//
// What moves: a resource's address (matched under the prefix, stripped before
// the inner matcher runs) and the request URL the inner handler reads.
// Content-negotiation (`produces`), method admission (`methods`), and per-route
// middlewares ride along unchanged. App-level middlewares are carried as
// prefix-scoped strategies. App lifecycle hooks (onStart/onResponse/…) are NOT
// carried — the composer owns lifecycle; mount it, then drive it.

import type { App, Context, Resource } from "./types.mjs";

// Normalize "/module/", "module" → "/module". Root ("" or "/") means no prefix.
function normalizePrefix(prefix: string): string {
  let p = prefix.trim();
  if (!p.startsWith("/")) p = "/" + p;
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "");
  return p === "/" ? "" : p;
}

// Is `path` within the prefix? Either the prefix exactly, or a child of it.
function underPrefix(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(prefix + "/");
}

// The inner path the mounted app should see: prefix removed, always rooted.
function stripPrefix(path: string, prefix: string): string {
  if (prefix === "") return path;
  if (path === prefix) return "/";
  const rest = path.slice(prefix.length);
  return rest.startsWith("/") ? rest : "/" + rest;
}

// Evaluate a resource's own matcher against an already-stripped path. Mirrors
// the pipeline's matchResource so a mounted resource matches exactly as it
// would at the root. (Kept local to avoid coupling the public surface to the
// pipeline's internals.)
function matchAddress(
  match: Resource["match"],
  path: string,
  ctx: Context,
): Record<string, string> | false {
  if (typeof match === "function") {
    const result = match(path, ctx);
    if (!result) return false;
    return typeof result === "object" ? result : {};
  }
  if (match instanceof RegExp) {
    const m = match.exec(path);
    return m ? { ...m.groups } : false;
  }
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

// A copy of the request context with its URL rebased to the stripped path, so
// an inner handler reading ctx.url.pathname sees where it thinks it lives.
function rebaseContext(ctx: Context, prefix: string): Context {
  const inner = stripPrefix(ctx.url.pathname, prefix);
  const url = new URL(inner + ctx.url.search + ctx.url.hash, ctx.url.origin);
  return new Proxy(ctx, {
    get(target, key, recv) {
      if (key === "url") return url;
      return Reflect.get(target, key, recv);
    },
  });
}

function mountResource(prefix: string, resource: Resource): Resource {
  return {
    ...resource,
    // Match only under the prefix; delegate to the original matcher on the rest.
    match: (path: string, ctx: Context) => {
      if (!underPrefix(path, prefix)) return false;
      return matchAddress(resource.match, stripPrefix(path, prefix), ctx);
    },
    ...(resource.route !== undefined ? { route: prefix + resource.route } : {}),
    handler: (ctx: Context) => resource.handler(rebaseContext(ctx, prefix)),
    ...(resource.middlewares !== undefined
      ? { middlewares: resource.middlewares.map((mw) => (ctx: Context) => mw(rebaseContext(ctx, prefix))) }
      : {}),
  };
}

/** Mount `app` under `prefix` as an App, ready to mergeApps into a host app.
 *  Resources answer under `<prefix>/…` with the prefix stripped before the
 *  inner app runs; app-level middlewares become prefix-scoped. */
export function mountAt(prefix: string, app: App): App {
  const p = normalizePrefix(prefix);
  const mounted: App = {
    resources: (app.resources ?? []).map((r) => mountResource(p, r)),
  };
  if (app.middlewares && app.middlewares.length) {
    mounted.middlewares = app.middlewares.map((mw) => (ctx: Context) =>
      underPrefix(ctx.url.pathname, p) ? mw(rebaseContext(ctx, p)) : [],
    );
  }
  return mounted;
}
