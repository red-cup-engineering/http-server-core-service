// server.ts — HTTP/HTTPS/HTTP2 server lifecycle with graceful shutdown.
import process from "node:process";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureServer as createH2SecureServer, createServer as createH2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import type { App, ClientError, StartResult } from "./types.mjs";
import { handler } from "./pipeline.mjs";

type RawServer = {
  headersTimeout?: number;
  requestTimeout?: number;
  keepAliveTimeout?: number;
  connectionsCheckingInterval?: number;
  maxRequestsPerSocket?: number | null;
  listen(port: number, cb: () => void): void;
  listen(port: number, host: string, cb: () => void): void;
  listen(port: number, host: string, backlog: number, cb: () => void): void;
  listen(options: ListenOptions, cb: () => void): void;
  listen(path: string, cb: () => void): void;
  close(cb?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  address(): AddressInfo | string | null;
};

type ManagedServer = RawServer & {
  closeGracefully: {
    (): Promise<void>;
    (grace: number): Promise<void>;
  };
};

type RawClientSocket = {
  destroyed?: boolean;
  writable?: boolean;
  end(data?: string | Buffer): void;
  destroy(): void;
};

export type GracefulShutdownPhase = "running" | "draining" | "closed" | "failed";

export type GracefulShutdownState = {
  phase: GracefulShutdownPhase;
  reason?: string;
  signal?: NodeJS.Signals;
  startedAt?: string;
  closedAt?: string;
  error?: string;
};

export type GracefulShutdownSignalSource = {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off?: (event: NodeJS.Signals, listener: () => void) => unknown;
  removeListener?: (event: NodeJS.Signals, listener: () => void) => unknown;
};

export type GracefulShutdownTarget =
  | Pick<StartResult, "close">
  | {
      closeGracefully: {
        (): Promise<void>;
        (grace: number): Promise<void>;
      };
    };

export type GracefulShutdownOptions = {
  signals?: readonly NodeJS.Signals[];
  grace?: number;
  source?: GracefulShutdownSignalSource;
  now?: () => Date;
  onDrain?: (state: GracefulShutdownState) => void | Promise<void>;
  onClosed?: (state: GracefulShutdownState) => void | Promise<void>;
  onError?: (error: unknown, state: GracefulShutdownState) => void | Promise<void>;
  forceExit?: false | ((code: number, signal: NodeJS.Signals) => void);
};

export type GracefulShutdownHandle = {
  readonly state: GracefulShutdownState;
  readonly draining: boolean;
  readonly promise: Promise<void> | null;
  drain: {
    (): Promise<void>;
    (reason: string): Promise<void>;
    (reason: string, grace: number): Promise<void>;
  };
  dispose(): void;
};

export type StartOptions = {
  port?: number;
  host?: string;
  backlog?: number;
  path?: string;
  signal?: AbortSignal;
  timeouts?: ServerTimeoutOptions;
};

export type ServerTimeoutOptions = {
  requestMs?: number;
  headersMs?: number;
  idleMs?: number;
  connectionsCheckingIntervalMs?: number;
  maxRequestsPerSocket?: number;
};

type ListenOptions = {
  port?: number;
  host?: string;
  backlog?: number;
  path?: string;
};

const DEFAULT_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
const SIGNAL_EXIT_OFFSETS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

function pickServer(app: App): RawServer {
  if (app.tls && app.http2) {
    return createH2SecureServer({ ...app.tls, allowHTTP1: true });
  }
  if (app.tls) {
    return createHttpsServer(app.tls);
  }
  if (app.http2) {
    return createH2Server();
  }
  return createHttpServer();
}

function upgradeMatches(match: NonNullable<App["upgrades"]>[number]["match"], req: IncomingMessage): boolean {
  if (match === undefined) return true;
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (typeof match === "string") return path === match;
  if (match instanceof RegExp) return match.test(path);
  try {
    if ((match as (value: string) => boolean)(path)) return true;
  } catch {}
  try {
    return Boolean((match as (value: IncomingMessage) => boolean)(req));
  } catch {
    return false;
  }
}

/**
 * createServer(app) — build a Node HTTP server bound to an app but NOT yet listening.
 * Attaches the request handler, upgrade dispatcher, connection tracking, and adds
 * `closeGracefully(grace?)` for drain-on-shutdown. Call `.listen()` or use `start()`.
 */
export function createServer(app: App): ManagedServer {
  const h = handler(app);
  const srv = pickServer(app);

  (srv as unknown as { on(e: string, l: (req: IncomingMessage, res: ServerResponse) => void): void })
    .on("request", h);
  (srv as unknown as { on(e: string, l: (req: IncomingMessage, res: ServerResponse) => void): void })
    .on("checkContinue", (req, res) => {
      void handleExpectContinue(app, h, req, res);
    });
  if (app.clientError !== false) {
    srv.on("clientError", (error, socket) => {
      void handleClientError(app, error as ClientError, socket);
    });
  }

  if (app.upgrades?.length) {
    srv.on("upgrade", (...upgradeArgs: unknown[]) => {
      const [req, socket, head] = upgradeArgs as [IncomingMessage, unknown, Buffer];
      for (const u of app.upgrades ?? []) {
        if (!upgradeMatches(u.match, req)) continue;
        if (u.handleUpgrade) {
          u.handleUpgrade(req, socket, head, { app });
          return;
        }
        if (u.handler) {
          u.handler(req, socket, head);
          return;
        }
      }
      (socket as { destroy(): void }).destroy();
    });
  }

  const sockets = new Set<unknown>();
  srv.on("connection", (socket: unknown) => {
    sockets.add(socket);
    (socket as { once(e: string, cb: () => void): void }).once("close", () => sockets.delete(socket));
    app.onConnection?.(socket);
    app.lifecycle?.onConnection?.(socket);
  });

  let closing: Promise<void> | null = null;
  const closeGracefully = (grace = 10_000): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const drained = new Promise<void>((resolve, reject) => {
        srv.close((error) => error ? reject(error) : resolve());
      });
      srv.closeIdleConnections?.();
      const timer = setTimeout(() => {
        if (srv.closeAllConnections) {
          srv.closeAllConnections();
        } else {
          for (const s of sockets) (s as { destroy(): void }).destroy();
        }
      }, grace);
      if (typeof (timer as unknown as { unref(): void }).unref === "function") {
        (timer as unknown as { unref(): void }).unref();
      }

      try {
        await Promise.all([
          drained,
          (async () => {
            await app.onStop?.(app);
            await app.lifecycle?.onStop?.(srv);
          })(),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  };

  return Object.assign(srv, { closeGracefully }) as ManagedServer;
}

async function handleExpectContinue(
  app: App,
  requestHandler: (req: IncomingMessage, res: ServerResponse) => void,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const decision = typeof app.expectContinue === "function"
      ? await app.expectContinue(req, res, app)
      : app.expectContinue;
    if (res.headersSent || res.writableEnded) return;
    if (decision === false) {
      res.writeHead(417, { "content-type": "text/plain; charset=utf-8" }).end("Expectation Failed");
      return;
    }
    res.writeContinue();
    requestHandler(req, res);
  } catch (error) {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
        .end(error instanceof Error ? error.message : "Internal Server Error");
    }
  }
}

function clientErrorStatus(error: ClientError): { status: number; reason: string } {
  if (error.code === "HPE_HEADER_OVERFLOW") return { status: 431, reason: "Request Header Fields Too Large" };
  return { status: 400, reason: "Bad Request" };
}

function writeDefaultClientError(error: ClientError, socket: unknown): void {
  const s = socket as Partial<RawClientSocket>;
  if (s.destroyed) return;
  const { status, reason } = clientErrorStatus(error);
  const response = `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  try {
    if (s.writable !== false && typeof s.end === "function") s.end(response);
    else if (typeof s.destroy === "function") s.destroy();
  } catch {
    try { s.destroy?.(); } catch {}
  }
}

async function handleClientError(app: App, error: ClientError, socket: unknown): Promise<void> {
  try {
    if (typeof app.clientError === "function") {
      const handled = await app.clientError(error, socket, app);
      if (handled === true) return;
    }
    writeDefaultClientError(error, socket);
  } catch {
    writeDefaultClientError(error, socket);
  }
}

export function installGracefulShutdown(
  target: GracefulShutdownTarget,
  options: GracefulShutdownOptions = {},
): GracefulShutdownHandle {
  const source = options.source ?? process;
  const signals = options.signals ?? DEFAULT_SHUTDOWN_SIGNALS;
  const grace = options.grace ?? 10_000;
  const now = options.now ?? (() => new Date()); // law-allow: wall-clock-as-data — injectable clock seam default; callers may pass now; shutdown deadline bookkeeping
  const listeners = new Map<NodeJS.Signals, () => void>();
  let state: GracefulShutdownState = { phase: "running" };
  let closePromise: Promise<void> | null = null;

  const snapshot = (): GracefulShutdownState => ({ ...state });

  const drain = (reason = "manual", requestedGrace = grace, signal?: NodeJS.Signals): Promise<void> => {
    if (closePromise) return closePromise;
    state = {
      phase: "draining",
      reason,
      ...(signal ? { signal } : {}),
      startedAt: now().toISOString(),
    };
    closePromise = (async () => {
      try {
        await options.onDrain?.(snapshot());
        await closeTarget(target, requestedGrace);
        state = {
          ...state,
          phase: "closed",
          closedAt: now().toISOString(),
        };
        await options.onClosed?.(snapshot());
      } catch (error) {
        state = {
          ...state,
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        await options.onError?.(error, snapshot());
        throw error;
      }
    })();
    return closePromise;
  };

  for (const signal of signals) {
    const listener = () => {
      if (state.phase === "draining" && options.forceExit) {
        options.forceExit(signalExitCode(signal), signal);
        return;
      }
      void drain(`signal:${signal}`, grace, signal).catch(() => {});
    };
    listeners.set(signal, listener);
    source.on(signal, listener);
  }

  return {
    get state() {
      return snapshot();
    },
    get draining() {
      return state.phase === "draining";
    },
    get promise() {
      return closePromise;
    },
    drain,
    dispose() {
      for (const [signal, listener] of listeners) {
        if (source.off) {
          source.off(signal, listener);
        } else {
          source.removeListener?.(signal, listener);
        }
      }
      listeners.clear();
    },
  };
}

async function closeTarget(target: GracefulShutdownTarget, grace: number): Promise<void> {
  if ("closeGracefully" in target) {
    await target.closeGracefully(grace);
  } else {
    await target.close(grace);
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (SIGNAL_EXIT_OFFSETS[signal] ?? 0);
}

function abortError(): Error {
  const error = new Error("start aborted");
  error.name = "AbortError";
  return error;
}

function removeServerListener(server: RawServer, event: string, listener: (...args: unknown[]) => void): void {
  if (server.off) server.off(event, listener);
  else server.removeListener?.(event, listener);
}

function listenOptions(portOrOptions: number | string | StartOptions | undefined): ListenOptions | string {
  if (typeof portOrOptions === "string") return portOrOptions;
  if (typeof portOrOptions === "number" || portOrOptions === undefined) {
    return { port: portOrOptions ?? 0 };
  }
  if (portOrOptions.path) {
    return {
      path: portOrOptions.path,
      ...(portOrOptions.backlog !== undefined ? { backlog: portOrOptions.backlog } : {}),
    };
  }
  return {
    port: portOrOptions.port ?? 0,
    ...(portOrOptions.host !== undefined ? { host: portOrOptions.host } : {}),
    ...(portOrOptions.backlog !== undefined ? { backlog: portOrOptions.backlog } : {}),
  };
}

function startSignal(portOrOptions: number | string | StartOptions | undefined): AbortSignal | undefined {
  return typeof portOrOptions === "object" ? portOrOptions.signal : undefined;
}

function startTimeouts(portOrOptions: number | string | StartOptions | undefined): ServerTimeoutOptions | undefined {
  return typeof portOrOptions === "object" ? portOrOptions.timeouts : undefined;
}

function applyServerTimeouts(server: RawServer, options: ServerTimeoutOptions | undefined): void {
  if (!options) return;
  const headersMs = options.headersMs ?? options.requestMs;
  if (headersMs !== undefined && "headersTimeout" in server) server.headersTimeout = headersMs;
  if (options.requestMs !== undefined && "requestTimeout" in server) server.requestTimeout = options.requestMs;
  if (options.idleMs !== undefined && "keepAliveTimeout" in server) server.keepAliveTimeout = options.idleMs;
  if (options.connectionsCheckingIntervalMs !== undefined && "connectionsCheckingInterval" in server) {
    server.connectionsCheckingInterval = options.connectionsCheckingIntervalMs;
  }
  if (options.maxRequestsPerSocket !== undefined && "maxRequestsPerSocket" in server) {
    server.maxRequestsPerSocket = options.maxRequestsPerSocket;
  }
}

function listen(server: RawServer, options: ListenOptions | string, onListening: () => void): void {
  if (typeof options === "string") {
    server.listen(options, onListening);
    return;
  }
  server.listen(options, onListening);
}

/** Listen on `port` (0 = ephemeral); resolves `{ server, port, close }`. */
export async function start(app: App, port?: number): Promise<StartResult>;
export async function start(app: App, path: string): Promise<StartResult>;
export async function start(app: App, options: StartOptions): Promise<StartResult>;
export async function start(app: App, portOrOptions?: number | string | StartOptions): Promise<StartResult> {
  const srv = createServer(app);
  applyServerTimeouts(srv, startTimeouts(portOrOptions));
  const signal = startSignal(portOrOptions);
  if (signal?.aborted) {
    await srv.closeGracefully(0).catch(() => {});
    throw abortError();
  }

  const actualPort = await new Promise<number>((resolve, reject) => {
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      srv.close(() => reject(abortError()));
    };
    const cleanup = () => {
      removeServerListener(srv, "error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    srv.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    listen(srv, listenOptions(portOrOptions), () => {
      cleanup();
      const addr = srv.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  const address = srv.address();

  await app.onStart?.(app);
  await app.lifecycle?.onStart?.(srv);

  return {
    server: srv,
    port: actualPort,
    address,
    // `close` is passed bare as a test/lifecycle hook, which calls it with a
    // context argument — only a real number may reach the grace timer.
    close: (grace?: number) => typeof grace === "number" ? srv.closeGracefully(grace) : srv.closeGracefully(),
  };
}
