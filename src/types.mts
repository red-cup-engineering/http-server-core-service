// types.mts — service-facing aliases for the lower HTTP app carrier.
//
// The App object language lives in @red-cup-engineering/computing-with-http/app. This
// service package is its Node runtime: listener, pipeline, upgrades, static
// bytes, OpenAPI, MCP, and executable transports.

import type {
  App as HttpApp,
  Body as HttpBody,
  ClientError as HttpClientError,
  ClientErrorHook as HttpClientErrorHook,
  Context as HttpContext,
  CorsOptions as HttpCorsOptions,
  CorsOriginPattern as HttpCorsOriginPattern,
  ErrorHookResult as HttpErrorHookResult,
  ExpectContinueHook as HttpExpectContinueHook,
  Handler as HttpHandler,
  HandlerResult as HttpHandlerResult,
  Middleware as HttpMiddleware,
  MiddlewareResult as HttpMiddlewareResult,
  Repr as HttpRepr,
  RequestHookResult as HttpRequestHookResult,
  RequestTrace as HttpRequestTrace,
  RequestTraceEntry as HttpRequestTraceEntry,
  Resource as HttpResource,
  ResponseTrailerValue as HttpResponseTrailerValue,
  ResponseTrailers as HttpResponseTrailers,
  SecurityHeaders as HttpSecurityHeaders,
  Servable as HttpServable,
  ServerLifecycle as HttpServerLifecycle,
  StartResult as HttpStartResult,
  StrictTransportSecurity as HttpStrictTransportSecurity,
  UpgradeHandler as HttpUpgradeHandler,
} from "@red-cup-engineering/computing-with-http/app";

export type App = HttpApp;
export type Resource = HttpResource;
export type Handler = HttpHandler;
export type Middleware = HttpMiddleware;
export type MiddlewareResult = HttpMiddlewareResult;
export type Context = HttpContext;
export type CorsOptions = HttpCorsOptions;
export type CorsOriginPattern = HttpCorsOriginPattern;
export type SecurityHeaders = HttpSecurityHeaders;
export type StrictTransportSecurity = HttpStrictTransportSecurity;
export type Body = HttpBody;
export type Repr = HttpRepr;
export type StartResult = HttpStartResult;
export type UpgradeHandler = HttpUpgradeHandler;
export type HandlerResult = HttpHandlerResult;
export type RequestHookResult = HttpRequestHookResult;
export type ErrorHookResult = HttpErrorHookResult;
export type ExpectContinueHook = HttpExpectContinueHook;
export type ClientError = HttpClientError;
export type ClientErrorHook = HttpClientErrorHook;
export type ResponseTrailers = HttpResponseTrailers;
export type ResponseTrailerValue = HttpResponseTrailerValue;
export type ServerLifecycle = HttpServerLifecycle;
export type RequestTrace = HttpRequestTrace;
export type RequestTraceEntry = HttpRequestTraceEntry;
export type Servable = HttpServable;
