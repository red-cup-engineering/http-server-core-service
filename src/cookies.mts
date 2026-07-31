// cookies.mts — transport adapters for the cookie codec.
//
// Representation lives in @red-cup-engineering/web-codecs-cookie; this module only
// moves the texts on and off node:http req/res objects.

import {
  assertCookieName,
  parseCookieHeader,
  serializeSetCookie,
  signCookieValue,
  unsignCookieValue,
  type CookieOptions,
} from "@red-cup-engineering/computing-with-http/codecs/cookie";
import type { IncomingMessage, ServerResponse } from "node:http";

export type DeleteCookieOptions = Omit<CookieOptions, "expires" | "maxAge">;

export function getCookie(req: IncomingMessage, name: string): string | null {
  assertCookieName(name);
  return parseCookieHeader(req.headers.cookie)[name] ?? null;
}

export function setCookie(res: ServerResponse, name: string, value: string, options: CookieOptions = {}): string {
  const cookie = serializeSetCookie(name, value, options);
  appendSetCookie(res, cookie);
  return cookie;
}

export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (existing === undefined) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), cookie]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), cookie]);
  }
}

export function deleteCookie(res: ServerResponse, name: string, options: DeleteCookieOptions = {}): string {
  return setCookie(res, name, "", {
    ...options,
    expires: new Date(0),
    maxAge: 0,
  });
}

export function setSignedCookie(
  res: ServerResponse,
  name: string,
  value: string,
  secret: string,
  options: CookieOptions = {},
): string {
  return setCookie(res, name, signCookieValue(value, secret, name), options);
}

export function getSignedCookie(req: IncomingMessage, name: string, secret: string): string | null {
  const value = getCookie(req, name);
  return value === null ? null : unsignCookieValue(value, secret, name);
}
