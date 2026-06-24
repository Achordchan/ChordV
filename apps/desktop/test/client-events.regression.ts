import assert from "node:assert/strict";
import {
  createClientRuntimeFallbackRefreshEventTypes,
  parseClientRuntimeEvent,
  parseServerSentEventBlock,
  splitServerSentEventBlocks
} from "../src/api/client";

function testParsesNestSseEventIdAndDataLines() {
  const block = [
    "id: 1710000000000-7",
    "event: ticket_updated",
    'data: {"type":"message",',
    'data: "occurredAt":"2026-06-04T00:00:00.000Z",',
    'data: "ticketId":"ticket_1"}'
  ].join("\r\n");

  const parsed = parseServerSentEventBlock(block);
  const event = parseClientRuntimeEvent(parsed);

  assert.equal(parsed.id, "1710000000000-7");
  assert.equal(parsed.event, "ticket_updated");
  assert.equal(event.type, "ticket_updated");
  assert.equal(event.ticketId, "ticket_1");
}

function testSplitsCrLfAndLfSseBlocks() {
  assert.deepEqual(splitServerSentEventBlocks("data: 1\r\n\r\ndata: 2\n\npartial"), [
    "data: 1",
    "data: 2",
    "partial"
  ]);
}

function testIgnoresCommentsAndPreservesDataSpacing() {
  const parsed = parseServerSentEventBlock([
    ": keepalive",
    "event: subscription_updated",
    'data: {"occurredAt":"2026-06-04T00:00:00.000Z"}'
  ].join("\n"));

  const event = parseClientRuntimeEvent(parsed);
  assert.equal(event.type, "subscription_updated");
}

function testFallbackRefreshIncludesPolicyUpdates() {
  assert.deepEqual(createClientRuntimeFallbackRefreshEventTypes(false), [
    "subscription_updated",
    "node_access_updated",
    "account_updated",
    "announcement_updated",
    "policy_updated",
    "ticket_updated"
  ]);
  assert.deepEqual(createClientRuntimeFallbackRefreshEventTypes(true), [
    "subscription_updated",
    "node_access_updated",
    "account_updated",
    "announcement_updated",
    "policy_updated",
    "ticket_updated",
    "version_updated"
  ]);
}

function main() {
  testParsesNestSseEventIdAndDataLines();
  testSplitsCrLfAndLfSseBlocks();
  testIgnoresCommentsAndPreservesDataSpacing();
  testFallbackRefreshIncludesPolicyUpdates();
  console.log("desktop client events regression checks passed");
}

main();
