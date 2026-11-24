import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";

/** True if the URL is HTTPS and its host is on the allowlist (exact match or subdomain). */
export function isAllowedUrl(raw: string, allowedHosts: string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((h) => {
    const allowed = h.toLowerCase();
    return host === allowed || host.endsWith("." + allowed);
  });
}

/**
 * fetch() that follows redirects only while they stay on the allowlist, so a
 * trusted bucket URL cannot bounce the service to an arbitrary host.
 */
export async function safeFetch(
  url: string,
  allowedHosts: string[],
  init: RequestInit = {},
  maxRedirects = 3,
): Promise<{ res: Response; finalUrl: string }> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    if (!isAllowedUrl(current, allowedHosts)) throw new Error(`URL not allowed: ${current}`);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

/** Size from a HEAD request, or null if the server does not say. */
export async function headSize(
  url: string,
  allowedHosts: string[],
  signal?: AbortSignal,
): Promise<{ bytes: number | null; finalUrl: string }> {
  const { res, finalUrl } = await safeFetch(url, allowedHosts, { method: "HEAD", signal });
  if (!res.ok) throw new Error(`HEAD ${res.status}`);
  const len = res.headers.get("content-length");
  return { bytes: len ? Number(len) : null, finalUrl };
}

/** Stream a download to disk, hashing as it goes and aborting past maxBytes. */
export async function downloadWithHash(
  url: string,
  dest: string,
  maxBytes: number,
  allowedHosts: string[],
  signal?: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  const { res } = await safeFetch(url, allowedHosts, { signal });
  if (!res.ok || !res.body) throw new Error(`GET ${res.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(dest);
  let bytes = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error(`Download exceeded ${maxBytes} bytes`);
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, "drain");
    }
  } finally {
    out.end();
    await once(out, "close");
  }
  return { sha256: hash.digest("hex"), bytes };
}
