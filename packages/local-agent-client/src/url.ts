import { failLocalAgentClient } from "./errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function normalizeLoopbackBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failLocalAgentClient("invalidBaseUrl");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failLocalAgentClient("invalidBaseUrl");
  }

  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    failLocalAgentClient("invalidBaseUrl");
  }

  return url.href.replace(/\/$/, "");
}

export function encodePathSegment(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    failLocalAgentClient("invalidArguments");
  }
  return encodeURIComponent(value);
}
