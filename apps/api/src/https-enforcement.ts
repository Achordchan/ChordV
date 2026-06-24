import { randomUUID } from "node:crypto";

export type ForceHttpsRequest = {
  secure?: boolean;
  headers: Record<string, string | string[] | undefined>;
};

export type ForceHttpsResponse = {
  setHeader?: (name: string, value: string) => void;
  status: (code: number) => { json: (body: unknown) => void };
};

export function forceHttpsMiddleware(req: ForceHttpsRequest, res: ForceHttpsResponse, next: () => void) {
  const forwardedProto = Array.isArray(req.headers["x-forwarded-proto"])
    ? req.headers["x-forwarded-proto"][0]
    : req.headers["x-forwarded-proto"];
  if (req.secure || forwardedProto === "https") {
    next();
    return;
  }
  const requestId = readHeader(req.headers, "x-request-id") ?? readHeader(req.headers, "cf-ray") ?? randomUUID();
  res.setHeader?.("X-Request-Id", requestId);
  res.status(426).json({
    message: "生产环境仅允许 HTTPS 访问",
    requestId
  });
}

function readHeader(headers: Record<string, string | string[] | undefined> | undefined, name: string) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? readHeaderCaseInsensitive(headers, name);
  return Array.isArray(value) ? value[0] : value;
}

function readHeaderCaseInsensitive(headers: Record<string, string | string[] | undefined> | undefined, name: string) {
  if (!headers) {
    return undefined;
  }
  const lowerName = name.toLowerCase();
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
  return matchedKey ? headers[matchedKey] : undefined;
}
