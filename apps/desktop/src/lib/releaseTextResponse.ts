/** Read decoded HTTP bytes without changing the signed UTF-8 text. */
export async function readReleaseTextResponse(url: string, response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, body: "", link: "" };
  }
  const source = new URL(url);
  const limit = source.hostname === "api.github.com" ? 8 << 20 : source.pathname.endsWith(".sig") ? 1024 : 1 << 20;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bytes = 0, body = "";
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("GitHub 发布信息过大。");
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("GitHub 发布信息过大。");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader?.releaseLock();
  }
  return { status: response.status, body, link: response.headers.get("link") ?? "" };
}
