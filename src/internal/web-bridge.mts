// internal/web-bridge.ts — Node IncomingMessage/ServerResponse <-> WHATWG Request/Response.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  applyTrailerHeader,
  immediateResponseTrailers,
  resolveResponseTrailers,
  writeResponseTrailers,
} from "./trailers.mjs";
import {
  bodyForbidden,
  pipeCompressed,
  planWebResponseCompression,
  writeContentCodingNotAcceptable,
  type WebResponseCompressionOptions,
} from "./web-response-compression.mjs";

export function toWebRequest(req: IncomingMessage, base = "http://localhost/"): Request {
  const url = new URL(req.url ?? "/", base);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(key, one);
    else if (value !== undefined) headers.set(key, String(value));
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
}

export type SendWebResponseOptions = {
  method?: string;
} & WebResponseCompressionOptions;

export async function sendWebResponse(
  res: ServerResponse,
  response: Response,
  options: SendWebResponseOptions = {},
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers) headers[key] = value;

  const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = cookieHeaders.getSetCookie?.() ?? [];
  if (cookies.length) {
    delete headers["set-cookie"]; // law-allow: delete-not-trace — set-cookie re-emitted via setHeader; header framing, not evidence
    res.setHeader("set-cookie", cookies);
  }

  const plan = planWebResponseCompression(response.status, headers, options);
  const immediateTrailers = immediateResponseTrailers(response);
  applyTrailerHeader(headers, immediateTrailers);
  if (plan.kind === "not-acceptable") {
    writeContentCodingNotAcceptable(headers);
    res.writeHead(406, headers);
    res.end((options.method ?? "").toUpperCase() === "HEAD" ? undefined : "Not Acceptable");
    return;
  }
  res.writeHead(response.status, headers);
  const method = (options.method ?? "").toUpperCase();
  if (!response.body || method === "HEAD" || bodyForbidden(response.status)) {
    res.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const source = Readable.fromWeb(response.body as unknown as NodeReadableStream).on("error", reject);
    const out = pipeCompressed(source, plan);
    out.on("error", reject);
    out.on("end", () => {
      void resolveResponseTrailers(response).then((trailers) => {
        writeResponseTrailers(res, trailers);
        res.end();
      }).then(resolve, reject);
    });
    out.pipe(res, { end: false });
  });
}
