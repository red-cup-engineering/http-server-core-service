// serve-scripts — generic HTTP transport for a named map of async scripts.
//
// serveScripts(scripts) creates a plain App whose routes are one GET per script
// key, mapped to /<key>. Query-string entries are forwarded as the params Record.
// JSON in, JSON out: same data whether the caller uses a JS import, a unix pipe
// to the CLI, or this HTTP wrapper.
import type { App, Context } from "./types.mjs";
import { jsonRepr } from "./http.mjs";

export type ScriptFn = (params: Record<string, string>) => Promise<unknown>;
export type ScriptMap = Record<string, ScriptFn>;

/** Wrap a named map of async functions as a minimal JSON App.
 *  Each entry in `scripts` becomes GET /<key> → application/json.
 *  A GET /health endpoint is always included, listing the script names. */
export function serveScripts(scripts: ScriptMap): App {
  const names = Object.keys(scripts);
  return {
    resources: [
      {
        match: "/health",
        methods: ["GET"],
        produces: ["application/json"],
        handler: () => jsonRepr({ status: "ok", scripts: names }),
      },
      ...names.map((name) => ({
        match: `/${name}`,
        methods: ["GET"] as const,
        produces: ["application/json"] as const,
        handler: async (ctx: Context) => {
          const params = Object.fromEntries(ctx.url.searchParams.entries());
          try {
            return jsonRepr(await scripts[name]!(params));
          } catch (err) {
            return jsonRepr({ error: err instanceof Error ? err.message : String(err) }, 500);
          }
        },
      })),
    ],
  };
}
