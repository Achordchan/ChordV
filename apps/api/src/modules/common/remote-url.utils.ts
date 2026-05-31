import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetch as undiciFetch } from "undici";

const DEFAULT_MAX_REDIRECTS = 5;

type FetchOptions = NonNullable<Parameters<typeof undiciFetch>[1]>;

export async function fetchPublicHttpUrl(
  rawUrl: string,
  options: FetchOptions = {},
  settings: { maxRedirects?: number; errorPrefix?: string } = {}
) {
  let currentUrl = parseHttpUrl(rawUrl, settings.errorPrefix);
  const maxRedirects = settings.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertPublicHttpUrl(currentUrl, settings.errorPrefix);
    const response = await undiciFetch(currentUrl, {
      ...options,
      redirect: "manual"
    });

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        resolvedUrl: currentUrl.toString()
      };
    }

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new BadRequestException(`${settings.errorPrefix ?? "Remote URL"} redirected without a Location header.`);
    }
    currentUrl = parseHttpUrl(new URL(location, currentUrl).toString(), settings.errorPrefix);
  }

  throw new BadRequestException(`${settings.errorPrefix ?? "Remote URL"} redirected too many times.`);
}

export async function assertPublicHttpUrl(rawUrl: string | URL, errorPrefix = "Remote URL") {
  const url = typeof rawUrl === "string" ? parseHttpUrl(rawUrl, errorPrefix) : rawUrl;
  await assertPublicHostname(url.hostname, errorPrefix);
}

function parseHttpUrl(rawUrl: string, errorPrefix = "Remote URL") {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`${errorPrefix} must be a valid HTTP(S) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestException(`${errorPrefix} must use HTTP or HTTPS.`);
  }
  return url;
}

async function assertPublicHostname(hostname: string, errorPrefix: string) {
  if (allowsPrivateRemoteUrlsForTests()) {
    return;
  }

  const literalIpVersion = isIP(hostname);
  if (literalIpVersion) {
    assertPublicIp(hostname, errorPrefix);
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new BadRequestException(`${errorPrefix} host did not resolve.`);
  }
  for (const address of addresses) {
    assertPublicIp(address.address, errorPrefix);
  }
}

function assertPublicIp(address: string, errorPrefix: string) {
  if (isPrivateOrReservedIp(address)) {
    throw new BadRequestException(`${errorPrefix} resolves to a private or reserved address.`);
  }
}

function isPrivateOrReservedIp(address: string) {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 ||
      a >= 224
    );
  }

  if (ipVersion === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

function isRedirectStatus(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function allowsPrivateRemoteUrlsForTests() {
  return process.env.CHORDV_ALLOW_PRIVATE_REMOTE_URLS === "true";
}
