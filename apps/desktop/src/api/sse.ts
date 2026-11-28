import type { ClientRuntimeEventDto } from "@chordv/shared";

export type ParsedServerSentEvent = {
  event: string | null;
  id: string | null;
  data: string | null;
};

export function splitServerSentEventBlocks(input: string) {
  return input.split(/\r\n\r\n|\n\n|\r\r/);
}

export function parseServerSentEventBlock(block: string): ParsedServerSentEvent {
  const dataLines: string[] = [];
  let eventName: string | null = null;
  let eventId: string | null = null;

  for (const rawLine of block.split(/\r\n|\r|\n/)) {
    if (!rawLine || rawLine.startsWith(":")) {
      continue;
    }

    const separatorIndex = rawLine.indexOf(":");
    const field = separatorIndex >= 0 ? rawLine.slice(0, separatorIndex) : rawLine;
    const rawValue = separatorIndex >= 0 ? rawLine.slice(separatorIndex + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventName = value.trim() || null;
    } else if (field === "id") {
      eventId = value.trim() || null;
    }
  }

  return {
    event: eventName,
    id: eventId,
    data: dataLines.length > 0 ? dataLines.join("\n") : null
  };
}

export function parseClientRuntimeEvent(event: ParsedServerSentEvent): ClientRuntimeEventDto {
  if (!event.data) {
    throw new Error("事件内容为空");
  }
  const parsed = JSON.parse(event.data) as Partial<ClientRuntimeEventDto>;
  const parsedType = typeof parsed.type === "string" ? (parsed.type as string) : "";
  if (event.event && (!parsedType || parsedType === "message")) {
    parsed.type = event.event as ClientRuntimeEventDto["type"];
  }
  if (!parsed.type) {
    throw new Error("事件类型为空");
  }
  return parsed as ClientRuntimeEventDto;
}

export function isReplayableEventId(value: string | null): boolean {
  if (typeof value !== "string" || value.length > 128) return false;
  if (/^[0-9]+-[0-9]+$/.test(value)) return true;
  const match = value.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:(0|[1-9][0-9]{0,19})$/i);
  if (!match) return false;
  return match[1].length < 20 || match[1] <= "18446744073709551615";
}
