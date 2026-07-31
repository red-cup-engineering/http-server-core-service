// internal/net.ts — IP normalization, CIDR parsing, and trusted-proxy client address.
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

export type CidrMatcher = {
  family: 4 | 6;
  contains(ip: string): boolean;
};

/** Strip IPv4-mapped IPv6 prefix (::ffff:) and zone id (%...). */
export function normalizeIp(ip: string | undefined): string {
  if (!ip) return "";
  let out = String(ip).trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(out);
  if (bracket) out = bracket[1]!;
  if ((out.match(/:/g) ?? []).length === 1 && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(out)) {
    out = out.split(":")[0]!;
  }
  const zone = out.indexOf("%");
  if (zone !== -1) out = out.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(out);
  return mapped?.[1] ?? out;
}

/** The real client IP: socket address or first X-Forwarded-For entry when explicitly trusted. */
export function clientIp(req: IncomingMessage, opts: { trustProxy?: boolean | number } = {}): string {
  if (opts.trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    const value = Array.isArray(fwd) ? fwd.join(",") : fwd;
    if (value) {
      const chain = value.split(",").map((part) => normalizeIp(part)).filter(Boolean);
      if (chain.length) {
        if (typeof opts.trustProxy === "number") {
          const idx = Math.max(0, chain.length - 1 - Math.max(0, opts.trustProxy));
          return chain[idx]!;
        }
        return chain[0]!;
      }
    }
    const real = req.headers["x-real-ip"];
    const realValue = Array.isArray(real) ? real[0] : real;
    if (realValue) return normalizeIp(realValue);
  }
  const connection = req as IncomingMessage & { connection?: { remoteAddress?: string } };
  return normalizeIp(req.socket?.remoteAddress ?? connection.connection?.remoteAddress);
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => ((acc << 8) + (Number(oct) & 255)) >>> 0, 0);
}

function ipv6ToBig(ip: string): bigint {
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    ip = ip.slice(0, v4.index) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = ip.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = rest ? rest.split(":").filter(Boolean) : [];
  const mid = Array(Math.max(0, 8 - left.length - right.length)).fill("0");
  return [...left, ...mid, ...right]
    .slice(0, 8)
    .reduce((acc, hextet) => (acc << 16n) + BigInt(`0x${hextet || "0"}`), 0n);
}

/** Parse a CIDR string into a matcher. Bare addresses match only themselves. */
export function parseCidr(cidr: string): CidrMatcher | null {
  const [rawAddr, lenText] = String(cidr).trim().split("/");
  const addr = normalizeIp(rawAddr);
  const family = isIP(addr);
  if (family !== 4 && family !== 6) return null;

  const bits = family === 4 ? 32 : 128;
  const len = lenText === undefined ? bits : Number(lenText);
  if (!Number.isInteger(len) || len < 0 || len > bits) return null;

  if (family === 4) {
    const base = ipv4ToInt(addr);
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return {
      family,
      contains(ip) {
        const normalized = normalizeIp(ip);
        return isIP(normalized) === 4 && (ipv4ToInt(normalized) & mask) === (base & mask);
      },
    };
  }

  const base = ipv6ToBig(addr);
  const mask = len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(128 - len);
  return {
    family,
    contains(ip) {
      const normalized = normalizeIp(ip);
      return isIP(normalized) === 6 && (ipv6ToBig(normalized) & mask) === (base & mask);
    },
  };
}

/** Test an IP against a CIDR string or parsed matcher. */
export function inCidr(ip: string, cidr: string | CidrMatcher | null): boolean {
  const matcher = typeof cidr === "string" ? parseCidr(cidr) : cidr;
  return matcher?.contains(ip) ?? false;
}
