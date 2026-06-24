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

const handleHeaderRefreshBody = extractFunctionBody("handleHeaderRefresh");
const loadSectionDataBody = extractFunctionBody("loadSectionData");

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

testHeaderRefreshDoesNotAlwaysLoadFullSnapshotFirst();
testOverviewKeepsFullSnapshotRefresh();
testSignalBackedSectionsUseLocalRefreshSignals();
testSnapshotBackedSectionsUseSectionLoader();
testCriticalSnapshotSectionsStayLocalInSectionLoader();

console.log("admin app header refresh regression checks passed");
