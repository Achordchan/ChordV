import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

function extractFunctionBody(functionName: string) {
  const signature = `async function ${functionName}`;
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `${functionName} should exist`);

  const bodyMarkerIndex = source.indexOf(") {", signatureIndex);
  assert.notEqual(bodyMarkerIndex, -1, `${functionName} should have a body`);
  const bodyStart = bodyMarkerIndex + 2;

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${functionName} body should be closed`);
}

function extractBranchBody(functionBody: string, marker: string) {
  const markerIndex = functionBody.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${marker} branch should exist`);

  const bodyStart = functionBody.indexOf("{", markerIndex);
  assert.notEqual(bodyStart, -1, `${marker} branch should have a body`);

  let depth = 0;
  for (let index = bodyStart; index < functionBody.length; index += 1) {
    const char = functionBody[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return functionBody.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${marker} branch should be closed`);
}

function extractBlockAfter(marker: string) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${marker} should exist`);

  const bodyStart = source.indexOf("{", markerIndex);
  assert.notEqual(bodyStart, -1, `${marker} should have a body`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  assert.fail(`${marker} body should be closed`);
}

const handleHeaderRefreshBody = extractFunctionBody("handleHeaderRefresh");
const loadSectionDataBody = extractFunctionBody("loadSectionData");
const adminRuntimeEventsBody = extractBlockAfter("return subscribeAdminRuntimeEvents((event) =>");

function testHeaderRefreshDoesNotAlwaysLoadFullSnapshotFirst() {
  assert.doesNotMatch(
    handleHeaderRefreshBody,
    /^\s*await loadFullSnapshot\(\);/,
    "header refresh must not start by forcing a full admin snapshot for every section"
  );
  assert.match(
    handleHeaderRefreshBody,
    /const currentSection = sectionRef\.current;/,
    "header refresh should use the latest selected section"
  );
}

function testOverviewKeepsFullSnapshotRefresh() {
  assert.match(
    handleHeaderRefreshBody,
    /if \(currentSection === "overview"\) {\s*await loadFullSnapshot\(\);\s*return;\s*}/,
    "overview header refresh can keep the full snapshot path"
  );
}

function testSignalBackedSectionsUseLocalRefreshSignals() {
  assert.match(
    handleHeaderRefreshBody,
    /if \(currentSection === "releases"\) {\s*setReleaseRefreshSignal\(\(current\) => current \+ 1\);\s*return;\s*}/,
    "release center header refresh should only notify the release page"
  );
  assert.match(
    handleHeaderRefreshBody,
    /if \(currentSection === "tickets"\) {\s*setTicketRefreshSignal\(\(current\) => current \+ 1\);\s*return;\s*}/,
    "ticket header refresh should only notify the ticket page"
  );
  assert.match(
    handleHeaderRefreshBody,
    /if \(currentSection === "runtimeComponents"\) {\s*setRuntimeComponentRefreshSignal\(\(current\) => current \+ 1\);\s*return;\s*}/,
    "runtime component header refresh should only notify the runtime component page"
  );
  assert.match(
    handleHeaderRefreshBody,
    /if \(currentSection === "imageBed"\) {\s*setImageBedRefreshSignal\(\(current\) => current \+ 1\);\s*return;\s*}/,
    "image bed header refresh should only notify the image bed page"
  );
}

function testSnapshotBackedSectionsUseSectionLoader() {
  assert.match(
    handleHeaderRefreshBody,
    /await loadSectionData\(currentSection, \{ force: true \}\);/,
    "snapshot-backed sections should refresh through the section loader instead of loadFullSnapshot"
  );
}

function testCriticalSnapshotSectionsStayLocalInSectionLoader() {
  const subscriptionsBranch = extractBranchBody(loadSectionDataBody, 'targetSection === "subscriptions"');
  assert.match(subscriptionsBranch, /fetchAdminSubscriptions\(\)/);
  assert.doesNotMatch(subscriptionsBranch, /fetchAdminDashboard\(\)|loadFullSnapshot\(\)/);

  const nodesBranch = extractBranchBody(loadSectionDataBody, 'targetSection === "nodes"');
  assert.match(nodesBranch, /fetchAdminNodes\(\)/);
  assert.doesNotMatch(nodesBranch, /fetchAdminDashboard\(\)|loadFullSnapshot\(\)/);
}

function testGenericAdminRuntimeEventsRefreshCurrentSection() {
  assert.match(
    adminRuntimeEventsBody,
    /if \(event\.type === "keepalive"\) {\s*return;\s*}/,
    "admin SSE keepalive events must not trigger data reloads"
  );
  assert.match(
    adminRuntimeEventsBody,
    /if \(event\.type === "sync_queue_updated"\) {[\s\S]*?return;\s*}/,
    "sync queue events should use the dedicated queue refresh path"
  );
  assert.match(
    adminRuntimeEventsBody,
    /if \(document\.visibilityState === "hidden"\) {\s*return;\s*}/,
    "hidden admin pages should not refresh visible data immediately"
  );
  assert.match(
    adminRuntimeEventsBody,
    /if \(sectionRef\.current === "tickets"\) {[\s\S]*?shouldRefreshTicketsForAdminEvent\(event\)[\s\S]*?return;\s*}/,
    "ticket pages should keep the ticket-specific SSE refresh gate"
  );
  assert.match(
    adminRuntimeEventsBody,
    /void refreshDashboard\(\{ silent: true \}\);[\s\S]*?void refreshCurrentSectionSilently\(\);/,
    "announcement, policy, subscription, and other generic admin SSE events must refresh the current section"
  );
}

testHeaderRefreshDoesNotAlwaysLoadFullSnapshotFirst();
testOverviewKeepsFullSnapshotRefresh();
testSignalBackedSectionsUseLocalRefreshSignals();
testSnapshotBackedSectionsUseSectionLoader();
testCriticalSnapshotSectionsStayLocalInSectionLoader();
testGenericAdminRuntimeEventsRefreshCurrentSection();

console.log("admin app header refresh regression checks passed");
