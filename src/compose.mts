// compose.ts — App composition: mergeApps folds multiple apps into one; compose applies plugins.
import type { App } from "./types.mjs";

function firstDefined<K extends keyof App>(apps: readonly App[], key: K): App[K] | undefined {
  for (const app of apps) {
    if (app[key] !== undefined) return app[key];
  }
  return undefined;
}

/** Merge multiple apps into one, combining their resources, middlewares, hooks, and options. */
export function mergeApps(...apps: App[]): App {
  const merged: App = {};

  merged.resources = apps.flatMap((a) => a.resources ?? []);
  merged.middlewares = apps.flatMap((a) => a.middlewares ?? []);
  merged.upgrades = apps.flatMap((a) => a.upgrades ?? []);

  // Lifecycle hooks: all are called in order
  const startHooks = apps.map((a) => a.onStart).filter(Boolean) as NonNullable<App["onStart"]>[];
  if (startHooks.length) merged.onStart = async (app) => { for (const h of startHooks) await h(app); };

  const stopHooks = apps.map((a) => a.onStop).filter(Boolean) as NonNullable<App["onStop"]>[];
  if (stopHooks.length) merged.onStop = async (app) => { for (const h of stopHooks) await h(app); };

  const connHooks = apps.map((a) => a.onConnection).filter(Boolean) as NonNullable<App["onConnection"]>[];
  if (connHooks.length) merged.onConnection = (socket) => { for (const h of connHooks) h(socket); };

  const lifecycles = apps.map((a) => a.lifecycle).filter(Boolean) as NonNullable<App["lifecycle"]>[];
  if (lifecycles.length) {
    const lifecycle: NonNullable<App["lifecycle"]> = {};
    const lifecycleStart = lifecycles.map((l) => l.onStart).filter(Boolean) as NonNullable<NonNullable<App["lifecycle"]>["onStart"]>[];
    if (lifecycleStart.length) lifecycle.onStart = async (server) => { for (const h of lifecycleStart) await h(server); };
    const lifecycleStop = lifecycles.map((l) => l.onStop).filter(Boolean) as NonNullable<NonNullable<App["lifecycle"]>["onStop"]>[];
    if (lifecycleStop.length) lifecycle.onStop = async (server) => { for (const h of lifecycleStop) await h(server); };
    const lifecycleConnections = lifecycles.map((l) => l.onConnection).filter(Boolean) as NonNullable<NonNullable<App["lifecycle"]>["onConnection"]>[];
    if (lifecycleConnections.length) lifecycle.onConnection = (socket) => { for (const h of lifecycleConnections) h(socket); };
    merged.lifecycle = lifecycle;
  }

  const responseHooks = apps.map((a) => a.onResponse).filter(Boolean) as NonNullable<App["onResponse"]>[];
  if (responseHooks.length) merged.onResponse = async (ctx) => { for (const h of responseHooks) await h(ctx); };

  // onRequest: first to return truthy short-circuits
  const requestHooks = apps.map((a) => a.onRequest).filter(Boolean) as NonNullable<App["onRequest"]>[];
  if (requestHooks.length) {
    merged.onRequest = async (ctx) => {
      for (const h of requestHooks) {
        const result = await h(ctx);
        if (result !== false && result !== undefined && result !== null) return result;
      }
    };
  }

  // onError: first provided wins
  const onError = apps.find((a) => a.onError)?.onError;
  if (onError) merged.onError = onError;

  // Scalar fields: first defined wins
  for (const key of ["tls", "http2", "cors", "base", "trustProxy", "cacheControl", "security", "problems"] as const) {
    const value = firstDefined(apps, key);
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  // locals: shallow-merge, later overrides earlier
  const localsList = apps.map((a) => a.locals).filter(Boolean) as Record<string, unknown>[];
  if (localsList.length) merged.locals = Object.assign({}, ...localsList);

  return merged;
}

/** Apply a sequence of plugins (functions App → App) left-to-right. */
export function compose(app: App, ...plugins: Array<(app: App) => App>): App {
  return plugins.reduce((a, p) => p(a), app);
}
