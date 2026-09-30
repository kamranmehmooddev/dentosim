/**
 * Error reporting (Sentry) with PHI stripped. Nothing that could identify a
 * patient leaves the platform: no request bodies, cookies, query strings, user
 * emails, file names or free text — only error types, stack frames and ids.
 */
import * as Sentry from "@sentry/node";
import { config } from "./config.js";

let started = false;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PATHISH = /(["'`])[^"'`]*\.(stl|obj|ply|3mf|gltf|glb|zip|7z|rar)\1/gi;
const TOKENISH = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Remove anything that could be PHI from a free-text string. */
export function scrubText(s: string): string {
  return s.replace(EMAIL, "[email]").replace(PATHISH, "[file]").replace(TOKENISH, "[token]");
}

export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  delete event.request?.data;
  delete event.request?.cookies;
  delete event.request?.query_string;
  if (event.request?.headers) event.request.headers = {};
  if (event.request?.url) event.request.url = event.request.url.replace(/\/setup\/[^/?#]+/, "/setup/[token]").replace(/\?.*$/, "");
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  delete event.breadcrumbs;
  if (event.message) event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrubText(ex.value);
  if (event.extra) for (const k of Object.keys(event.extra)) if (typeof event.extra[k] === "string") event.extra[k] = scrubText(event.extra[k] as string);
  return event;
}

export function initTelemetry(service: string): void {
  const dsn = config().SENTRY_DSN;
  if (!dsn || started) return;
  Sentry.init({ dsn, environment: config().NODE_ENV, serverName: service, sendDefaultPii: false, beforeSend: (e) => scrubEvent(e), tracesSampleRate: 0 });
  started = true;
}

export function captureError(err: Error, context: Record<string, string> = {}): void {
  if (config().NODE_ENV !== "test") console.error(`[error] ${scrubText(err.message)}`, context);
  if (started) Sentry.captureException(err, { extra: context });
}
