import { BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_DNS_LOOKUP_TIMEOUT_MS = 5_000;

type FetchOptions = NonNullable<Parameters<typeof undiciFetch>[1]>;
type DnsLookup = typeof lookup;
type UndiciLookupOptions = LookupOptions;
type UndiciLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;
type FetchPublicHttpUrlSettings = {
  maxRedirects?: number;
  errorPrefix?: string;
  dnsLookupTimeoutMs?: number;
  dnsLookup?: DnsLookup;
  /**
   * When true, EVERY hop (the initial URL and every redirect target) must be
   * https. Used where transport security is the only integrity guarantee, so an
   * https→http redirect downgrade must be rejected rather than followed.
   */
  requireHttps?: boolean;
};

const publicHttpDispatcher = new Agent({
  connect: {
    lookup(hostname: string, options: UndiciLookupOptions, callback: UndiciLookupCallback) {
      void lookupPublicHostname(hostname, "Remote URL", {}, options).then(
        (addresses) => {
          if (options.all) {
            callback(null, addresses);
            return;
          }
          const first = addresses[0];
          callback(null, first.address, first.family);
        },
        (error) => callback(error as NodeJS.ErrnoException, "", 0)
      );
    }
  }
});

export async function fetchPublicHttpUrl(
  rawUrl: string,
  options: FetchOptions = {},
  settings: FetchPublicHttpUrlSettings = {}
) {
  let currentUrl = parseHttpUrl(rawUrl, settings.errorPrefix, settings.requireHttps);
  const maxRedirects = settings.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertPublicHttpUrl(currentUrl, settings.errorPrefix, settings);
    const response = await fetchWithPublicDispatcher(currentUrl, options, settings);

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
    currentUrl = parseHttpUrl(new URL(location, currentUrl).toString(), settings.errorPrefix, settings.requireHttps);
  }

  throw new BadRequestException(`${settings.errorPrefix ?? "Remote URL"} redirected too many times.`);
}

async function fetchWithPublicDispatcher(
  url: string | URL,
  options: FetchOptions,
  settings: FetchPublicHttpUrlSettings
) {
  try {
    return await undiciFetch(url, {
      ...options,
      dispatcher: options.dispatcher ?? createPublicHttpDispatcher(settings),
      redirect: "manual"
    });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : null;
    if (cause instanceof BadRequestException) {
      throw cause;
    }
    throw error;
  }
}

function createPublicHttpDispatcher(settings: FetchPublicHttpUrlSettings) {
  if (!settings.dnsLookup && !settings.dnsLookupTimeoutMs) {
    return publicHttpDispatcher;
  }
  return new Agent({
    connect: {
      lookup(hostname: string, options: UndiciLookupOptions, callback: UndiciLookupCallback) {
        void lookupPublicHostname(hostname, settings.errorPrefix ?? "Remote URL", settings, options).then(
          (addresses) => {
            if (options.all) {
              callback(null, addresses);
              return;
            }
            const first = addresses[0];
            callback(null, first.address, first.family);
          },
          (error) => callback(error as NodeJS.ErrnoException, "", 0)
        );
      }
    }
  });
}

export async function assertPublicHttpUrl(
  rawUrl: string | URL,
  errorPrefix = "Remote URL",
  settings: Pick<FetchPublicHttpUrlSettings, "dnsLookupTimeoutMs" | "dnsLookup"> = {}
) {
  const url = typeof rawUrl === "string" ? parseHttpUrl(rawUrl, errorPrefix) : rawUrl;
  await assertPublicHostname(url.hostname, errorPrefix, settings);
}

function parseHttpUrl(rawUrl: string, errorPrefix = "Remote URL", requireHttps = false) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException(`${errorPrefix} must be a valid HTTP(S) URL.`);
  }
  if (requireHttps) {
    if (url.protocol !== "https:") {
      throw new BadRequestException(`${errorPrefix} must use HTTPS (no downgrade allowed).`);
    }
    return url;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequestException(`${errorPrefix} must use HTTP or HTTPS.`);
  }
  return url;
}

async function assertPublicHostname(
  hostname: string,
  errorPrefix: string,
  settings: Pick<FetchPublicHttpUrlSettings, "dnsLookupTimeoutMs" | "dnsLookup"> = {}
) {
  if (allowsPrivateRemoteUrlsForTests()) {
    return;
  }

  const literalIpVersion = isIP(hostname);
  if (literalIpVersion) {
    assertPublicIp(hostname, errorPrefix);
    return;
  }

  const addresses = await lookupPublicHostname(hostname, errorPrefix, settings);
  if (addresses.length === 0) {
    throw new BadRequestException(`${errorPrefix} host did not resolve.`);
  }
}

async function lookupPublicHostname(
  hostname: string,
  errorPrefix: string,
  settings: Pick<FetchPublicHttpUrlSettings, "dnsLookupTimeoutMs" | "dnsLookup"> = {},
  options: UndiciLookupOptions = {}
) {
  const addresses = await lookupHostnameWithTimeout(
    hostname,
    errorPrefix,
    settings.dnsLookup ?? lookup,
    readDnsLookupTimeoutMs(settings.dnsLookupTimeoutMs)
  );
  if (addresses.length === 0) {
    throw new BadRequestException(`${errorPrefix} host did not resolve.`);
  }
  const family = normalizeLookupFamily(options.family);
  const matchingAddresses = family > 0 ? addresses.filter((address) => address.family === family) : addresses;
  if (matchingAddresses.length === 0) {
    throw new BadRequestException(`${errorPrefix} host did not resolve to a supported address family.`);
  }
  for (const address of matchingAddresses) {
    assertPublicIp(address.address, errorPrefix);
  }
  return matchingAddresses;
}

function normalizeLookupFamily(family: LookupOptions["family"]) {
  if (family === 4 || family === 6) {
    return family;
  }
  if (family === "IPv4") {
    return 4;
  }
  if (family === "IPv6") {
    return 6;
  }
  return 0;
}

async function lookupHostnameWithTimeout(hostname: string, errorPrefix: string, dnsLookup: DnsLookup, timeoutMs: number) {
  let settled = false;
  const lookupTask = dnsLookup(hostname, { all: true, verbatim: true }).then(
    (addresses) => {
      settled = true;
      return addresses;
    },
    (error) => {
      settled = true;
      throw error;
    }
  );
  void lookupTask.catch(() => undefined);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      reject(new BadRequestException(`${errorPrefix} DNS lookup timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([lookupTask, timeoutTask]);
  } finally {
    if (settled && timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
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

function readDnsLookupTimeoutMs(override?: number) {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const parsed = Number(process.env.CHORDV_REMOTE_DNS_LOOKUP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_DNS_LOOKUP_TIMEOUT_MS;
}
