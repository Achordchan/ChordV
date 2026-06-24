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
const submitDrawerBody = extractFunctionBody("submitDrawer");
const saveNodeAccessEditorBody = extractFunctionBody("saveNodeAccessEditor");
const handleDeleteTeamMemberBody = extractFunctionBody("handleDeleteTeamMember");
const handleToggleUserStatusBody = extractFunctionBody("handleToggleUserStatus");
const handleDisconnectUserBody = extractFunctionBody("handleDisconnectUser");
const handleKickMemberBody = extractFunctionBody("handleKickMember");
const handleResetSubscriptionTrafficBody = extractFunctionBody("handleResetSubscriptionTraffic");
const handleConvertToTeamBody = extractFunctionBody("handleConvertToTeam");
const saveTeamInlineEditorBody = extractFunctionBody("saveTeamInlineEditor");
const saveTeamSubscriptionInlineEditorBody = extractFunctionBody("saveTeamSubscriptionInlineEditor");
const saveTeamMemberInlineEditorBody = extractFunctionBody("saveTeamMemberInlineEditor");
const handleSessionExpiredStateBody = extractBlockAfter("function handleSessionExpiredState()");
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
    /if \(event\.type === "runtime_component_updated" && sectionRef\.current === "runtimeComponents"\) {[\s\S]*?setRuntimeComponentRefreshSignal\(\(current\) => current \+ 1\);[\s\S]*?return;\s*}/,
    "runtime component background validation events should refresh the runtime component page without waiting for focus"
  );
  assert.match(
    adminRuntimeEventsBody,
    /if \(event\.type === "release_center_updated" && sectionRef\.current === "releases"\) {[\s\S]*?setReleaseRefreshSignal\(\(current\) => current \+ 1\);[\s\S]*?return;\s*}/,
    "release center admin events should refresh the release page without waiting for focus"
  );
  assert.match(
    adminRuntimeEventsBody,
    /if \(event\.type === "image_bed_updated" && sectionRef\.current === "imageBed"\) {[\s\S]*?setImageBedRefreshSignal\(\(current\) => current \+ 1\);[\s\S]*?return;\s*}/,
    "image bed admin events should refresh the image bed page without waiting for focus"
  );
  assert.match(
    adminRuntimeEventsBody,
    /void refreshDashboard\(\{ silent: true \}\);[\s\S]*?void refreshCurrentSectionSilently\(\);/,
    "announcement, policy, subscription, and other generic admin SSE events must refresh the current section"
  );
}

function testSignalBackedSectionsRefreshSilentlyThroughSignals() {
  const refreshBody = extractBlockAfter("function refreshCurrentSectionSilently()");
  assert.match(
    refreshBody,
    /if \(sectionRef\.current === "tickets"\) {[\s\S]*?setTicketRefreshSignal\(\(current\) => current \+ 1\);[\s\S]*?return;\s*}/,
    "tickets should refresh through its local signal"
  );
  assert.match(
    refreshBody,
    /if \(sectionRef\.current === "imageBed"\) {[\s\S]*?setImageBedRefreshSignal\(\(current\) => current \+ 1\);[\s\S]*?return;\s*}/,
    "image bed should refresh through its local signal"
  );
  assert.match(
    refreshBody,
    /if \(sectionRef\.current === "runtimeComponents"\) {[\s\S]*?setRuntimeComponentRefreshSignal\(\(current\) => current \+ 1\);[\s\S]*?return;\s*}/,
    "runtime components should refresh through its local signal"
  );
}

function testSessionExpiredClearsBusyRefs() {
  const refs = [
    "adminSecuritySavingRef",
    "drawerBusyRef",
    "deleteNodeSubmittingRef",
    "kickSubmittingRef",
    "resetTrafficBusyRef",
    "convertSubmittingRef",
    "entityActionBusyRef",
    "probingBusyRef",
    "refreshingNodeRef",
    "panelSyncRetryBusyRef",
    "leaseRevocationRetryBusyRef",
    "policySavingRef",
    "nodeAccessSavingRef",
    "teamProfileBusyRef",
    "teamMemberBusyRef",
    "teamSubscriptionBusyRef"
  ];

  for (const ref of refs) {
    assert.match(handleSessionExpiredStateBody, new RegExp(`${ref}\\.current\\s*=`), `${ref} should be reset on session expiry`);
  }
}

function testSubscriptionCreateRequiresExpireAtBeforeRequest() {
  const personalBranch = extractBranchBody(submitDrawerBody, 'drawer.type === "subscription-create"');
  assert.match(personalBranch, /const expireAt = readRequiredExpireAt\(subscriptionCreateForm\.expireAt\);/);
  assert.match(personalBranch, /if \(!expireAt\) {\s*return;\s*}/);
  assert.doesNotMatch(personalBranch, /new Date\(\)\.toISOString\(\)/);

  const teamBranch = extractBranchBody(submitDrawerBody, 'drawer.type === "team-subscription" && drawer.parentId');
  assert.match(teamBranch, /const expireAt = readRequiredExpireAt\(teamSubscriptionForm\.expireAt\);/);
  assert.match(teamBranch, /buildCreateTeamSubscriptionPayload\(teamSubscriptionForm, expireAt\)/);
}

function testNodeAccessPendingSaveUsesYellowCompletedNotification() {
  assert.match(
    saveNodeAccessEditorBody,
    /const panelSyncPending = result\.panelSyncStatus === "pending";/,
    "node access save should detect backend pending panel sync status"
  );
  assert.match(
    saveNodeAccessEditorBody,
    /color: panelSyncPending \? "yellow" : "green"/,
    "node access save should show pending panel sync as yellow instead of red failure"
  );
  assert.match(
    saveNodeAccessEditorBody,
    /title: panelSyncPending \? "已保存，后台同步待处理" : "操作成功"/,
    "node access pending save should be treated as completed with background sync pending"
  );
  assert.match(
    saveNodeAccessEditorBody,
    /if \(panelSyncPending\) {[\s\S]*?refreshPanelSyncJobsAfterPending\(\)/,
    "node access pending save should refresh the sync queue"
  );
}

function testNodeAccessOptionsAllowOfflineAndPendingNodes() {
  const nodeOptionsBlock = extractBlockAfter("const nodeOptions = useMemo");
  assert.doesNotMatch(
    nodeOptionsBlock,
    /disabled:/,
    "node access options should not disable offline or pending-sync nodes"
  );
  assert.match(
    source,
    /function buildNodeAccessOptionLabel\(node: AdminNodeRecordDto\) {[\s\S]*?translateNodeAccessPanelStatus\(node\)[\s\S]*?node\.panelSyncPendingCount \? `待同步 \$\{node\.panelSyncPendingCount\}` : null[\s\S]*?node\.panelSyncFailedCount \? `失败 \$\{node\.panelSyncFailedCount\}` : null/,
    "node access options should display offline and pending-sync information in labels"
  );
  assert.match(
    source,
    /if \(!node\.panelEnabled\) {[\s\S]*?return "面板停用";[\s\S]*?if \(node\.panelStatus === "offline"\) {[\s\S]*?return "离线";/,
    "node access option labels should expose offline panel state without blocking save"
  );
}

function testUserSubscriptionAndTeamMutationsUseDbFirstActionHandling() {
  const branchMarkers = [
    'drawer.type === "user"',
    'drawer.type === "subscription-create"',
    'drawer.type === "subscription-adjust" && drawer.recordId',
    'drawer.type === "subscription-renew" && drawer.recordId',
    'drawer.type === "subscription-change-plan" && drawer.recordId',
    'drawer.type === "team"',
    'drawer.type === "team-member" && drawer.parentId',
    'drawer.type === "team-subscription" && drawer.parentId'
  ];

  for (const marker of branchMarkers) {
    const branch = extractBranchBody(submitDrawerBody, marker);
    assert.match(
      branch,
      /runAction\([\s\S]*?dbFirstMutationOptions/,
      `${marker} must use DB-first action handling so saved-but-pending panel sync is shown as yellow completed state`
    );
    assert.match(
      branch,
      /if \(success\) forceCloseDrawer\(\);/,
      `${marker} must only close the drawer after runAction reports completion`
    );
  }
}

function testInlineAndDestructiveMutationsUseDbFirstActionHandling() {
  for (const [name, body] of [
    ["delete team member", handleDeleteTeamMemberBody],
    ["toggle user status", handleToggleUserStatusBody],
    ["disconnect user", handleDisconnectUserBody],
    ["kick team member", handleKickMemberBody],
    ["reset subscription traffic", handleResetSubscriptionTrafficBody],
    ["convert subscription to team", handleConvertToTeamBody],
    ["save team inline editor", saveTeamInlineEditorBody],
    ["save team subscription inline editor", saveTeamSubscriptionInlineEditorBody],
    ["save team member inline editor", saveTeamMemberInlineEditorBody]
  ] as const) {
    assert.match(
      body,
      /runAction\([\s\S]*?dbFirstMutationOptions/,
      `${name} must use DB-first action handling so offline panels do not become red hard failures`
    );
  }
}

function testHighRiskMutationsReleaseBusyStateInFinally() {
  const expectations = [
    [handleDeleteTeamMemberBody, /finally\s*{[\s\S]*?entityActionBusyRef\.current = null;[\s\S]*?setEntityActionBusyKey\(null\);[\s\S]*?}/],
    [handleToggleUserStatusBody, /finally\s*{[\s\S]*?entityActionBusyRef\.current = null;[\s\S]*?setEntityActionBusyKey\(null\);[\s\S]*?}/],
    [handleDisconnectUserBody, /finally\s*{[\s\S]*?entityActionBusyRef\.current = null;[\s\S]*?setEntityActionBusyKey\(null\);[\s\S]*?}/],
    [handleKickMemberBody, /finally\s*{[\s\S]*?setKickSubmitting\(false\);[\s\S]*?kickSubmittingRef\.current = false;[\s\S]*?}/],
    [handleResetSubscriptionTrafficBody, /finally\s*{[\s\S]*?setResetTrafficBusyKey\(null\);[\s\S]*?resetTrafficBusyRef\.current = false;[\s\S]*?}/],
    [handleConvertToTeamBody, /finally\s*{[\s\S]*?convertSubmittingRef\.current = false;[\s\S]*?setConvertSubmitting\(false\);[\s\S]*?}/],
    [saveTeamInlineEditorBody, /finally\s*{[\s\S]*?teamProfileBusyRef\.current = null;[\s\S]*?setTeamProfileBusyKey\(null\);[\s\S]*?}/],
    [saveTeamSubscriptionInlineEditorBody, /finally\s*{[\s\S]*?teamSubscriptionBusyRef\.current = null;[\s\S]*?setTeamSubscriptionBusyKey\(null\);[\s\S]*?}/],
    [saveTeamMemberInlineEditorBody, /finally\s*{[\s\S]*?teamMemberBusyRef\.current = null;[\s\S]*?setTeamMemberBusyKey\(null\);[\s\S]*?}/]
  ] as const;

  for (const [body, pattern] of expectations) {
    assert.match(body, pattern, "high-risk admin mutations must release busy state in finally blocks");
  }
}

testHeaderRefreshDoesNotAlwaysLoadFullSnapshotFirst();
testOverviewKeepsFullSnapshotRefresh();
testSignalBackedSectionsUseLocalRefreshSignals();
testSnapshotBackedSectionsUseSectionLoader();
testCriticalSnapshotSectionsStayLocalInSectionLoader();
testGenericAdminRuntimeEventsRefreshCurrentSection();
testSignalBackedSectionsRefreshSilentlyThroughSignals();
testSessionExpiredClearsBusyRefs();
testSubscriptionCreateRequiresExpireAtBeforeRequest();
testNodeAccessPendingSaveUsesYellowCompletedNotification();
testNodeAccessOptionsAllowOfflineAndPendingNodes();
testUserSubscriptionAndTeamMutationsUseDbFirstActionHandling();
testInlineAndDestructiveMutationsUseDbFirstActionHandling();
testHighRiskMutationsReleaseBusyStateInFinally();

console.log("admin app header refresh regression checks passed");
