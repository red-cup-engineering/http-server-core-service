// route-admission.ts — pure MEMETICS admission reports for HTTP resources.

import type { Resource } from "./types.mjs";
import { negotiateLanguage, negotiateType } from "@red-cup-engineering/computing-with-http/codecs/negotiation";
import {
  settleRequestTrace,
  type RequestAdmissionJudgment,
  type RequestTrace,
  type RequestTraceSettlement,
} from "./request.mjs";

export type RouteAdmissionResource = Pick<Resource, "methods" | "produces" | "languages"> | null;

export type RouteAdmissionDenial = "route" | "method" | "accept" | "accept-language" | null;

export type RouteAdmissionInput = Readonly<{
  trace: RequestTrace;
  resource: RouteAdmissionResource;
  method: string;
  accept?: string;
  acceptLanguage?: string;
}>;

export type RouteAdmissionReport = Readonly<{
  trace: RequestTrace;
  settled: RequestTraceSettlement;
  judgments: readonly RequestAdmissionJudgment[];
  denial: RouteAdmissionDenial;
  allow: string | null;
  negotiatedType?: string;
  negotiatedLanguage?: string;
}>;

export function routeAllowedMethods(resource: RouteAdmissionResource): readonly string[] | null {
  if (!resource?.methods) return null;
  const allowed = new Set(resource.methods.map((method) => method.toUpperCase()));
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  return Object.freeze([...allowed]);
}

export function routeAllowHeader(resource: RouteAdmissionResource): string | null {
  const allowed = routeAllowedMethods(resource);
  return allowed ? allowed.join(", ") : null;
}

export function routeMethodAllowed(resource: RouteAdmissionResource, method: string): boolean {
  const allowed = routeAllowedMethods(resource);
  return !allowed || allowed.includes(method.toUpperCase());
}

export function routeAdmissionJudgments(input: RouteAdmissionInput): {
  judgments: readonly RequestAdmissionJudgment[];
  denial: RouteAdmissionDenial;
  allow: string | null;
  negotiatedType?: string;
  negotiatedLanguage?: string;
} {
  const routePath = input.trace.id;
  if (!input.resource) {
    return {
      judgments: Object.freeze([{
        name: "route",
        value: "absurd",
        reason: "no resource matched path",
        path: routePath,
      }]),
      denial: "route",
      allow: null,
    };
  }

  const allow = routeAllowHeader(input.resource);
  const method = input.method.toUpperCase();
  if (!routeMethodAllowed(input.resource, method)) {
    return {
      judgments: Object.freeze([{
        name: "method",
        value: "active",
        reason: `method ${method} not admitted by [${allow ?? "all"}]`,
        path: routePath,
      }]),
      denial: "method",
      allow,
    };
  }

  const offered = input.resource.produces ?? [];
  const negotiatedType = offered.length ? negotiateType(input.accept, offered) : null;
  if (offered.length && !negotiatedType) {
    return {
      judgments: Object.freeze([{
        name: "accept",
        value: "active",
        reason: `no admitted representation in [${offered.join(",")}]`,
        path: routePath,
      }]),
      denial: "accept",
      allow,
    };
  }

  const languages = input.resource.languages ?? [];
  const negotiatedLanguage = languages.length ? negotiateLanguage(input.acceptLanguage, languages) : null;
  if (languages.length && !negotiatedLanguage) {
    return {
      judgments: Object.freeze([{
        name: "accept-language",
        value: "active",
        reason: `no admitted language in [${languages.join(",")}]`,
        path: routePath,
      }]),
      denial: "accept-language",
      allow,
      ...(negotiatedType !== null ? { negotiatedType } : {}),
    };
  }

  return {
    judgments: Object.freeze([{
      name: "route",
      value: "potential",
      reason: "resource admitted for handling",
      path: routePath,
    }]),
    denial: null,
    allow,
    ...(negotiatedType !== null ? { negotiatedType } : {}),
    ...(negotiatedLanguage !== null ? { negotiatedLanguage } : {}),
  };
}

export function routeAdmissionReport(input: RouteAdmissionInput): RouteAdmissionReport {
  const projection = routeAdmissionJudgments(input);
  const settled = settleRequestTrace(input.trace, projection.judgments);
  return Object.freeze({
    trace: input.trace,
    settled,
    judgments: projection.judgments,
    denial: projection.denial,
    allow: projection.allow,
    ...(projection.negotiatedType !== undefined ? { negotiatedType: projection.negotiatedType } : {}),
    ...(projection.negotiatedLanguage !== undefined ? { negotiatedLanguage: projection.negotiatedLanguage } : {}),
  });
}
