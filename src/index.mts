// Core
export { start, createServer, installGracefulShutdown } from "./server.mjs";
export type {
  GracefulShutdownHandle,
  GracefulShutdownOptions,
  GracefulShutdownPhase,
  GracefulShutdownSignalSource,
  GracefulShutdownState,
  GracefulShutdownTarget,
  ServerTimeoutOptions,
  StartOptions,
} from "./server.mjs";
export { handler, contextFor } from "./pipeline.mjs";
export { mergeApps, compose } from "./compose.mjs";
export { mountAt } from "./mount-app.mjs";
export { staticFiles, DEFAULT_TYPES } from "./static.mjs";
// SSE framing lives in @red-cup-engineering/web-codecs-sse; import it directly.
export {
  createProjectedEventHub,
  createSseHub,
  writeSseComment,
  writeSseEvent,
} from "./sse.mjs";
export type { SseHub, SseSink, TopicEvent } from "./sse.mjs";
export { traceRequest, claimOf, allClaims, appendEntries } from "./request.mjs";
export type {
  RequestAdmissionJudgment,
  RequestTrace,
  RequestTraceEntry,
  RequestTraceSettlement,
} from "./request.mjs";
export {
  routeAdmissionJudgments,
  routeAdmissionReport,
  routeAllowedMethods,
  routeAllowHeader,
  routeMethodAllowed,
} from "./route-admission.mjs";
export type {
  RouteAdmissionDenial,
  RouteAdmissionInput,
  RouteAdmissionReport,
  RouteAdmissionResource,
} from "./route-admission.mjs";
// HTTP header-value representations (dates, etags, ranges, Cache-Control,
// Link, Content-Type, the precondition evaluators) live in
// @red-cup-engineering/web-codecs-http; import them directly.
// The multipart/form-data representation lives in
// @red-cup-engineering/web-codecs-multipart; readMultipartBody here is its transport.
export {
  applyCors, corsOriginAllowed, corsPreflight, corsPreflightDecision, appendVary, readBody, send,
  readFormBody, readJsonBody, readMultipartBody, readTextBody,
  sse, strongEtag, ensureDateHeader, applyCacheControl,
  applySecurityHeaders, emptyRepr, htmlRepr, jsonRepr, textRepr,
} from "./http.mjs";
export type {
  BodyParseOptions,
  JsonBodyOptions,
  JsonReprOptions,
  ReprOptions,
  TextReprOptions,
  CorsPreflightDecision,
} from "./http.mjs";
// Content negotiation lives in @red-cup-engineering/web-codecs-negotiation; import it directly.
export { compress, compressStream, decompress, decompressStream, zstdSupported, CODINGS } from "./compress.mjs";
export {
  HttpProblem,
  httpProblem,
  isHttpProblem,
  problem,
  problemDetails,
  problemErrorHandler,
  problemFromError,
  problemRepr,
  resolveProblemInstance,
  sendProblem,
  statusTitle,
} from "./problem.mjs";
export type { HttpProblemOptions, ProblemDetails, ProblemResponseOptions } from "./problem.mjs";
// Cookie representation lives in @red-cup-engineering/web-codecs-cookie; only the
// node:http transport adapters are this package's to export.
export {
  appendSetCookie,
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
} from "./cookies.mjs";
export type { DeleteCookieOptions } from "./cookies.mjs";
export { wellKnown } from "./well-known.mjs";
export type { WellKnownEntry, WellKnownOptions } from "./well-known.mjs";

// Script transport
export { serveScripts } from "./serve-scripts.mjs";
export type { ScriptFn, ScriptMap } from "./serve-scripts.mjs";
export {
  createMcpApp,
  DEFAULT_PROTOCOL_VERSION,
} from "./mcp.mjs";
export type {
  Json,
  McpApp,
  McpAppOptions,
  McpAuth,
  McpDispatch,
  McpRequestMeta,
  McpTool,
  McpToolAnnotations,
} from "./mcp.mjs";

// Types
export type {
  App, Resource, Handler, Middleware, MiddlewareResult, Context,
  CorsOptions, CorsOriginPattern, SecurityHeaders, StrictTransportSecurity,
  Body, Repr, StartResult, UpgradeHandler, HandlerResult, RequestHookResult, ErrorHookResult,
  ExpectContinueHook, ClientError, ClientErrorHook, ResponseTrailers, ResponseTrailerValue,
  Servable,
} from "./types.mjs";

// Edge, mesh, platform, and observability moved to their own sibling
// packages (@red-cup-engineering/http-edge-service, mesh-networking-service,
// http-platform-emulation-service, http-observability-service); import them
// directly from there.
