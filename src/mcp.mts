import {
  bearerChallenge,
  bearerToken,
} from "@red-cup-engineering/computing-with-http/codecs/http";
import { sseFrame } from "@red-cup-engineering/computing-with-http/codecs/sse";
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  MCP_JSON_TYPE,
  mcpInitializeResult,
  mcpOk,
  mcpRpcError,
  mcpToolStructuredResult,
  mcpToolTextError,
  mcpToolTextResult,
  mcpToolsListResult,
  type Json,
  type JsonObject,
  type McpServerInfo,
  type McpTool,
  type McpToolAnnotations,
} from "@red-cup-engineering/computing-with-http/codecs/mcp";

import { readBody } from "./http.mjs";
import type { JsonSchema } from "@red-cup-engineering/computer-web-server/openapi";
import { validateJsonSchema } from "@red-cup-engineering/computer-web-server/validation";
import type { App, Context, Repr } from "./types.mjs";

export const DEFAULT_PROTOCOL_VERSION = DEFAULT_MCP_PROTOCOL_VERSION;

export type {
  Json,
  McpTool,
  McpToolAnnotations,
};

/** Request-scoped metadata handed to a dispatch alongside the tool call. The
 *  `bearer` is the verified access token (when the request carried one), so a
 *  tool can resolve WHO is calling — e.g. to key per-user state. Absent on
 *  loopback requests, which bypass the bearer gate. */
export type McpRequestMeta = Readonly<{ bearer?: string }>;

export type McpDispatch = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  meta?: McpRequestMeta,
) => unknown | Promise<unknown>;

export type McpAuth = Readonly<{
  verify: (bearer: string) => boolean;
  realm: string;
  resourceMetadataUrl: string;
}>;

export type McpOriginPolicy = readonly (string | RegExp)[] | ((origin: string, ctx: Context) => boolean);

export type McpAppOptions = Readonly<{
  path?: string;
  serverInfo: McpServerInfo;
  protocolVersion?: string;
  acceptedProtocolVersions?: readonly string[];
  instructions?: string;
  tools: readonly McpTool[];
  dispatch: McpDispatch;
  auth?: McpAuth;
  allowedOrigins?: McpOriginPolicy;
  maxBodyBytes?: number;
  toolsPageSize?: number;
}>;

export type McpApp = Readonly<{ app: App }>;

const DEFAULT_PATH = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 65_536;
const LEGACY_MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const TOOLS_CURSOR_COLLECTION = "tools";

function json(body: unknown, status = 200): Repr {
  return { status, type: MCP_JSON_TYPE, body: JSON.stringify(body) };
}

function prefersEventStream(ctx: Context): boolean {
  const accept = ctx.req.headers.accept;
  const joined = Array.isArray(accept) ? accept.join(",") : accept;
  if (joined === undefined) return false;
  const media = joined.toLowerCase().split(",").map((entry) => entry.trim().split(";", 1)[0]);
  return media.includes("text/event-stream") && !media.includes(MCP_JSON_TYPE);
}

function rpc(ctx: Context, body: unknown, status = 200): Repr {
  if (!prefersEventStream(ctx)) return json(body, status);
  return {
    status,
    type: "text/event-stream; charset=utf-8",
    headers: Object.freeze({
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    }),
    body: sseFrame("message", body),
  };
}

function unsupportedMcpGet(ctx: Context): Repr {
  return {
    status: 405,
    type: "text/plain; charset=utf-8",
    headers: Object.freeze({ allow: "POST" }),
    body: ctx.req.method === "HEAD" ? "" : "Method Not Allowed",
  };
}

function isLoopbackRequest(ctx: Context): boolean {
  if (ctx.req.headers["x-forwarded-for"] !== undefined) return false;
  if (ctx.req.headers["forwarded"] !== undefined) return false;
  const addr = ctx.req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function unauthorized(auth: McpAuth | undefined): Repr {
  return {
    status: 401,
    type: MCP_JSON_TYPE,
    headers: {
      "www-authenticate": bearerChallenge(auth
        ? {
            realm: auth.realm,
            error: "invalid_token",
            resourceMetadata: auth.resourceMetadataUrl,
          }
        : { error: "invalid_token" }),
    },
    body: JSON.stringify({ error: "invalid_token" }),
  };
}

function badProtocolVersion(): Repr {
  return {
    status: 400,
    type: MCP_JSON_TYPE,
    body: JSON.stringify({ error: "unsupported_protocol_version" }),
  };
}

function forbiddenOrigin(): Repr {
  return {
    status: 403,
    type: MCP_JSON_TYPE,
    body: JSON.stringify({ error: "forbidden_origin" }),
  };
}

function argumentsRecord(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const args = params?.["arguments"];
  return args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value as Record<string, unknown>).every(isJson);
  }
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value as Record<string, unknown>).every(isJson);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isMcpRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function isClientResponse(message: Record<string, unknown>): boolean {
  return message["jsonrpc"] === "2.0"
    && !hasOwn(message, "method")
    && (hasOwn(message, "result") || hasOwn(message, "error"));
}

function canonicalOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function originPatternAllowed(origin: string, pattern: string | RegExp): boolean {
  return pattern instanceof RegExp ? pattern.test(origin) : canonicalOrigin(pattern) === origin;
}

function originAllowed(origin: string, ctx: Context, policy: McpOriginPolicy | undefined): boolean {
  if (origin === ctx.url.origin) return true;
  if (policy === undefined) return false;
  if (typeof policy === "function") return policy(origin, ctx);
  return policy.some((pattern) => originPatternAllowed(origin, pattern));
}

function originError(ctx: Context, policy: McpOriginPolicy | undefined): Repr | undefined {
  const header = ctx.req.headers.origin;
  if (header === undefined) return undefined;
  const origin = headerValue(header);
  if (origin === undefined) return forbiddenOrigin();
  const canonical = canonicalOrigin(origin);
  if (canonical === undefined || !originAllowed(canonical, ctx, policy)) return forbiddenOrigin();
  return undefined;
}

function acceptedProtocolVersions(options: Pick<McpAppOptions, "acceptedProtocolVersions" | "protocolVersion">): ReadonlySet<string> {
  return new Set(options.acceptedProtocolVersions ?? [options.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION, LEGACY_MCP_PROTOCOL_VERSION]);
}

function protocolVersionError(ctx: Context, accepted: ReadonlySet<string>): Repr | undefined {
  const value = ctx.req.headers[MCP_PROTOCOL_VERSION_HEADER];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !accepted.has(value)) return badProtocolVersion();
  return undefined;
}

function toolsCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ collection: TOOLS_CURSOR_COLLECTION, offset }), "utf8").toString("base64url");
}

function parseToolsCursor(cursor: unknown): number {
  if (typeof cursor !== "string") throw new Error("tools/list cursor must be a string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid tools/list cursor");
  }
  if (!isJsonObject(parsed) || parsed["collection"] !== TOOLS_CURSOR_COLLECTION) throw new Error("invalid tools/list cursor");
  const offset = parsed["offset"];
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid tools/list cursor");
  return offset;
}

function normalizeToolsPageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) return undefined;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error("MCP toolsPageSize must be a positive integer");
  return pageSize;
}

function listTools(
  tools: readonly McpTool[],
  pageSize: number | undefined,
  params: Record<string, unknown> | undefined,
): ReturnType<typeof mcpToolsListResult> {
  const cursor = params?.["cursor"];
  if (pageSize === undefined) {
    if (cursor !== undefined) throw new Error("tools/list cursor is not valid for this endpoint");
    return mcpToolsListResult(tools);
  }

  const start = cursor === undefined ? 0 : parseToolsCursor(cursor);
  if (start > tools.length || (start === tools.length && tools.length > 0)) throw new Error("invalid tools/list cursor");
  const end = Math.min(start + pageSize, tools.length);
  return mcpToolsListResult(tools.slice(start, end), end < tools.length ? toolsCursor(end) : undefined);
}

function resultForTool(tool: McpTool | undefined, value: unknown): ReturnType<typeof mcpToolTextResult> {
  if (tool?.outputSchema === undefined) return mcpToolTextResult(value);
  if (!isJsonObject(value)) {
    throw new Error(`tool ${tool.name} declared outputSchema but returned non-object structured content`);
  }
  const validation = validateJsonSchema(value, tool.outputSchema as JsonSchema);
  if (!validation.valid) {
    throw new Error(`tool ${tool.name} returned structured content outside outputSchema: ${validation.issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ")}`);
  }
  return mcpToolStructuredResult(value);
}

function argumentsForTool(tool: McpTool | undefined, args: Record<string, unknown>): Record<string, unknown> {
  if (tool?.inputSchema === undefined) return args;
  const validation = validateJsonSchema(args, tool.inputSchema as JsonSchema);
  if (!validation.valid) {
    throw new Error(`tool ${tool.name} arguments outside inputSchema: ${validation.issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ")}`);
  }
  return args;
}

export function createMcpApp(options: McpAppOptions): McpApp {
  const path = options.path ?? DEFAULT_PATH;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const protocolVersions = acceptedProtocolVersions(options);
  const originPolicy = options.allowedOrigins;
  const toolsPageSize = normalizeToolsPageSize(options.toolsPageSize);
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));

  const dispatchMessage = async (message: unknown, meta: McpRequestMeta): Promise<unknown | undefined> => {
    if (!isRecord(message)) return mcpRpcError(null, -32600, "invalid request");
    if (isClientResponse(message)) return undefined;
    if (message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
      return mcpRpcError(null, -32600, "invalid request");
    }

    const id = message["id"];
    const method = message["method"];
    const params = isRecord(message["params"]) ? message["params"] : undefined;
    if (id === undefined) return undefined;
    if (!isMcpRequestId(id)) return mcpRpcError(null, -32600, "invalid request");

    if (method === "initialize") {
      return mcpOk(id, mcpInitializeResult({
        serverInfo: options.serverInfo,
        ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      }));
    }

    if (method === "ping") return mcpOk(id, {});

    if (method === "tools/list") {
      try {
        return mcpOk(id, listTools(options.tools, toolsPageSize, params));
      } catch (error) {
        return mcpRpcError(id, -32602, error instanceof Error ? error.message : "invalid tools/list params");
      }
    }

    if (method === "tools/call") {
      const toolName = String(params?.["name"] ?? "");
      try {
        const tool = toolsByName.get(toolName);
        const result = await options.dispatch(toolName, argumentsForTool(tool, argumentsRecord(params)), meta);
        return mcpOk(id, resultForTool(tool, result));
      } catch (error) {
        return mcpOk(id, mcpToolTextError(error));
      }
    }

    return mcpRpcError(id, -32601, "method not found");
  };

  const handler = async (ctx: Context): Promise<Repr> => {
    const versionError = protocolVersionError(ctx, protocolVersions);
    if (versionError !== undefined) return versionError;
    const badOrigin = originError(ctx, originPolicy);
    if (badOrigin !== undefined) return badOrigin;

    const token = bearerToken(ctx.req.headers.authorization);
    if (!isLoopbackRequest(ctx)) {
      if (!options.auth || !token || !options.auth.verify(token)) return unauthorized(options.auth);
    }
    const meta: McpRequestMeta = token ? { bearer: token } : {};

    if (ctx.req.method === "GET" || ctx.req.method === "HEAD") return unsupportedMcpGet(ctx);

    let raw: Buffer;
    try {
      raw = await readBody(ctx.req, maxBodyBytes);
    } catch {
      return json({ error: "body read failed" }, 400);
    }

    let message: unknown;
    try {
      message = JSON.parse(raw.toString("utf-8")) as unknown;
    } catch {
      return rpc(ctx, mcpRpcError(null, -32700, "parse error"));
    }

    if (Array.isArray(message)) {
      if (message.length === 0) return rpc(ctx, mcpRpcError(null, -32600, "invalid request"));
      const responses = [];
      for (const item of message) {
        const response = await dispatchMessage(item, meta);
        if (response !== undefined) responses.push(response);
      }
      return responses.length === 0 ? { status: 202 } : rpc(ctx, responses);
    }

    const response = await dispatchMessage(message, meta);
    return response === undefined ? { status: 202 } : rpc(ctx, response);
  };

  return {
    app: {
      resources: [
        {
          match: path,
          methods: ["GET", "HEAD", "POST"],
          handler,
        },
      ],
    },
  };
}
