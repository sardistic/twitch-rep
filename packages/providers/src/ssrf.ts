import { isIP } from "node:net";

/**
 * SSRF guard for provider base URLs. Rejects non-http(s) schemes and URLs
 * whose host is a loopback, link-local, or private-network address unless the
 * deployment explicitly allows self-hosted providers. Hostname-based DNS
 * rebinding is out of scope here; providers run server-side with no
 * credentials attached to internal services.
 */
export function validateProviderBaseUrl(raw: string, allowPrivateNetworks: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Provider base URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Provider base URL must not embed credentials");
  }
  const host = url.hostname.toLowerCase();
  if (!allowPrivateNetworks && isPrivateHost(host)) {
    throw new Error(
      "Provider base URL resolves to a private or local network (set ALLOW_PRIVATE_PROVIDER_NETWORKS=true for self-hosted providers)",
    );
  }
  return url;
}

export function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const version = isIP(bare);
  if (version === 4) return isPrivateIpv4(bare);
  if (version === 6) return isPrivateIpv6(bare);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = [parts[0]!, parts[1]!];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:127.") ||
    lower.startsWith("::ffff:10.") ||
    lower.startsWith("::ffff:192.168.")
  );
}
