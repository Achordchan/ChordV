import { renewalBase, renewalDate } from "../src/features/editors/renewal-date";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const adminSrcRoot = resolve(import.meta.dirname, "../src");
const appSource = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
const customerSubscriptionsPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/CustomerSubscriptionsPage.tsx"), "utf8");
const sectionCardSource = readFileSync(resolve(import.meta.dirname, "../src/features/shared/SectionCard.tsx"), "utf8");
const overviewPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/OverviewPage.tsx"), "utf8");
const usersPageSource = ["CustomerWorkspace.tsx", "CustomerSubscription.tsx", "CustomerNodes.tsx", "CustomerMembers.tsx", "CustomerActivity.tsx", "CustomerTaskStatus.tsx", "TeamEditors.tsx"].map(file => readFileSync(resolve(import.meta.dirname, "../src/features/customers", file), "utf8")).join("\n");
const plansPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/PlansPage.tsx"), "utf8");
const subscriptionsPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/SubscriptionsPage.tsx"), "utf8");
const nodesPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/NodesPage.tsx"), "utf8");
const announcementsPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/AnnouncementsPage.tsx"), "utf8");
const releasesPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/ReleasesPage.tsx"), "utf8");
const imageBedPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/ImageBedPage.tsx"), "utf8");
const policiesPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/PoliciesPage.tsx"), "utf8");
const runtimeComponentsPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/RuntimeComponentsPage.tsx"), "utf8");
const runtimeComponentsPanelSource = readFileSync(resolve(import.meta.dirname, "../src/features/runtime-components/RuntimeComponentsPanel.tsx"), "utf8");
const runtimeComponentEditorSource = readFileSync(resolve(import.meta.dirname, "../src/features/runtime-components/RuntimeComponentEditorModal.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

function readFilesRecursively(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return readFilesRecursively(path);
    }
    return path.match(/\.(ts|tsx|css)$/) ? [path] : [];
  });
}

function findActionIconsMissingAccessibleNames() {
  const missing: string[] = [];
  for (const path of readFilesRecursively(adminSrcRoot).filter((item) => item.endsWith(".tsx"))) {
    const source = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (node.tagName.getText(sourceFile) === "ActionIcon") {
          const names = new Set(
            node.attributes.properties.filter(ts.isJsxAttribute).map((attribute) => attribute.name.getText(sourceFile))
          );
          if (!names.has("aria-label")) {
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            missing.push(`${path}:${position.line + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return missing;
}

function testSidebarKeepsGroupedInformationArchitecture() {
  for (const title of ["工作台", "用户与订阅", "节点与任务", "客服与公告", "应用发布", "系统"]) {
    assert.match(appSource, new RegExp(`title: "${title}"`), `sidebar group ${title} should exist`);
  }

  assert.match(appSource, /label: "客户与订阅"/);
  assert.match(appSource, /label: "订阅与授权"/);
  assert.doesNotMatch(appSource, /description: "查看运营总览、异常任务和关键状态"/);
  assert.doesNotMatch(appSource, /description=\{item\.description\}/);
  assert.doesNotMatch(appSource, /\{sectionMeta\[section\]\.description\}/);
  assert.match(appSource, /\{ title: "用户与订阅", sections: \["users", "plans"\] \}/);
  assert.doesNotMatch(appSource, /\{ title: "用户与订阅", sections: \["users", "subscriptions", "plans"\] \}/);
  assert.match(appSource, /label: "节点与同步"/);
  assert.doesNotMatch(appSource, />\s*后台工具\s*</);
  assert.match(appSource, /label: "系统设置"/);
  assert.match(appSource, /<SystemSettingsPage/);
  const settingsSource = readFileSync(resolve(import.meta.dirname, "../src/pages/SystemSettingsPage.tsx"), "utf8");
  for (const action of ["onOpenSecurity", "onOpenTasks", "onOpenPolicies", "onOpenImageBed", "onLogout"]) assert.ok(settingsSource.includes(action));
  assert.match(appSource, /className="admin-nav-shell"/);
  assert.match(appSource, /className="admin-nav-menu"/);
  assert.match(stylesSource, /\.admin-nav\s*\{[\s\S]*overflow: hidden;/);
  assert.match(stylesSource, /\.admin-nav-shell\s*\{[\s\S]*min-height: 0;/);
  assert.match(stylesSource, /\.admin-nav-menu\s*\{[\s\S]*overflow-y: auto;/);
}

function testCustomerSubscriptionsPageCombinesRelatedWorkWithoutMergingBusinessLogic() {
  assert.match(appSource, /<CustomerSubscriptionsPage/);
  assert.match(appSource, /customers=\{/);
  assert.match(appSource, /<UsersPage/);
  assert.match(appSource, /subscriptions=\{subscriptions\}/);
  assert.match(appSource, /allSubscriptions=\{allSubscriptions\}/);
  assert.match(appSource, /onOpenRenewDrawer=\{\(subscriptionId\) => openDrawer\("subscription-renew", subscriptionId\)\}/);
  assert.doesNotMatch(appSource, /activeTab=\{customerSubscriptionsTab\}/);
  assert.doesNotMatch(appSource, /customerSubscriptionsTab/);
  assert.doesNotMatch(customerSubscriptionsPageSource, /<Tabs/);
  assert.doesNotMatch(customerSubscriptionsPageSource, /value="customers"/);
  assert.doesNotMatch(customerSubscriptionsPageSource, /value="subscriptions"/);
  assert.doesNotMatch(customerSubscriptionsPageSource, /先按客户定位账号和团队/);
}

function testSectionCardSupportsPageIntentAndActions() {
  assert.match(sectionCardSource, /title\?: string;/);
  assert.match(sectionCardSource, /description\?: string;/);
  assert.match(sectionCardSource, /actions\?: ReactNode;/);
  assert.match(sectionCardSource, /searchPlaceholder\?: string;/);
  assert.match(sectionCardSource, /\{props\.actions\}/);
  assert.match(sectionCardSource, /className="admin-section-card-search"/);
  assert.match(stylesSource, /\.admin-section-card-tools/);
  assert.match(stylesSource, /\.admin-section-card-search/);
}

function testOverviewPrioritizesActionableWork() {
assert.ok(overviewPageSource.indexOf("待处理事项") < overviewPageSource.indexOf("className={styles.metrics}")); for(const action of ["onOpenSyncQueue","onOpenTickets","onOpenNodes","onOpenCustomers","onOpenTeams"]) assert.ok(overviewPageSource.includes(action));
}

function testUsersPageKeepsAccountAndTeamEntrypoints() {
  const route = readFileSync(resolve(import.meta.dirname, "../src/pages/UsersPage.tsx"), "utf8");
  assert.match(route, /CustomerWorkspace as UsersPage/);
  assert.match(usersPageSource, /aria-label="客户列表"/);
  assert.match(usersPageSource, /aria-label="客户类型"/);
  assert.match(usersPageSource, /<Tabs.Panel/);
  for (const action of ["onOpenUserDrawer", "onCreateSubscriptionForUser", "onOpenTeamSubscriptions", "onOpenRenewDrawer", "onOpenChangePlanDrawer", "onOpenAdjustDrawer", "onOpenNodeAccessEditor", "onResetSubscriptionTraffic", "onToggleUserStatus", "onToggleTeamUserStatus", "onDisconnectUser", "onLoadTeamUsage", "onOpenTeamUsageDetail", "onOpenTeamInlineEditor", "onOpenTeamMemberInlineEditor", "onDeleteTeamMember", "onRetryLeaseRevocationJob", "onOpenLeaseRevocationQueue"]) {
    assert.ok(usersPageSource.includes(action), action + " must remain wired to the real customer workspace");
  }
  assert.match(usersPageSource, /getSubscriptionNodeAccess\(subscription.id\)/);
  assert.match(usersPageSource, /if \(!active\) return/);
  assert.doesNotMatch(usersPageSource, /example\.com|INITIAL_CUSTOMERS|原型模式/);
  assert.match(usersPageSource, /member.role !== "owner"/);
  assert.match(usersPageSource, /onDisconnectUser\(member.userId, member.displayName, "team-member"\)/);
  assert.match(usersPageSource, /onDisconnectUser\(customer.user!.id, customer.name, "personal"\)/);
  assert.match(usersPageSource, /<CustomerActivity/);
  assert.match(appSource, /teamUsageByTeamId=\{teamUsageByTeamId\}/);
  assert.match(appSource, /onOpenTeamUsageDetail=\{setTeamUsageDetailTarget\}/);
}

function testSubscriptionsPageKeepsSubscriptionActions() {
  assert.match(subscriptionsPageSource, /title="订阅与授权"/);
  assert.doesNotMatch(subscriptionsPageSource, /订阅续期、变更套餐、节点授权和流量处理集中在这里。/);
  assert.match(subscriptionsPageSource, /searchPlaceholder="搜索用户、套餐或团队"/);
  assert.match(subscriptionsPageSource, /个人订阅 · \{personalSubscriptions\.length\}/);
  assert.match(subscriptionsPageSource, /Team 订阅 · \{props\.filteredTeamSubscriptions\.length\}/);
  assert.match(subscriptionsPageSource, /onOpenRenewDrawer\(item\.id\)/);
  assert.match(subscriptionsPageSource, /onOpenChangePlanDrawer\(item\.id\)/);
  assert.match(subscriptionsPageSource, /onOpenAdjustDrawer\(item\.id\)/);
  assert.match(subscriptionsPageSource, /onOpenConvertToTeamModal\(item\)/);
  assert.match(subscriptionsPageSource, /onOpenNodeAccessEditor\(item\.id/);
  assert.match(subscriptionsPageSource, /onResetSubscriptionTraffic\(item\.id/);
  assert.match(subscriptionsPageSource, /onOpenTeamSubscriptionInlineEditor\(team\.id\)/);
  assert.match(subscriptionsPageSource, /onOpenKickMemberModal\(team\.id, member\.id, member\.displayName\)/);
}

function testPlansAndAnnouncementsExposePageIntent() {
for(const action of ["onOpenPlanDrawer"]) assert.ok(plansPageSource.includes(action)); for(const action of ["onOpenAnnouncementDrawer","onDeleteAnnouncement","actionBusyKey"]) assert.ok(announcementsPageSource.includes(action)); assert.match(plansPageSource,/aria-label="套餐规则"/); assert.match(announcementsPageSource,/aria-label="公告列表"/);
}

function testReleaseAndImageBedPagesExposePageIntent() {
for(const action of ["openCreateRelease","loadReleases","publishRelease","withdrawRelease"]) assert.ok(releasesPageSource.includes(action)); for(const action of ["handleSave","handleDelete","loadFiles","onBusyChange","confirmation.dialog"]) assert.ok(imageBedPageSource.includes(action));
}

function testPoliciesAndRuntimeComponentsUseCurrentNavigationNames() {
assert.match(policiesPageSource,/onSave/); assert.match(runtimeComponentsPanelSource,/RuntimeComponentSlotCard/); assert.match(runtimeComponentsPanelSource,/全局下载镜像已迁移至系统设置/); assert.match(runtimeComponentsPanelSource,/复制下载地址/); assert.match(runtimeComponentEditorSource,/高级选项/);
}

function testNodesPageKeepsNodeAndSyncTaskActions() {
for(const action of ["onProbeNode","onProbeAll","onOpenNodeDrawer","onDeleteNode","onOpenLeaseRevocationQueue","onRetryNodeLeaseRevocationJobs","onResumeAgentNode"]) assert.ok(nodesPageSource.includes(action)); assert.match(nodesPageSource,/aria-label="节点与同步"/);
}

function testProductionCopyUsesSyncTaskNaming() {
  for (const path of readFilesRecursively(adminSrcRoot)) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /同步队列/, `${path} should use 同步任务 for user-facing copy`);
    assert.doesNotMatch(source, /后台同步队列/, `${path} should use 后台同步任务 for user-facing copy`);
    assert.doesNotMatch(source, /内核组件/, `${path} should use 客户端组件 for user-facing copy`);
  }
}

function testIconOnlyActionsHaveAccessibleNames() {
  const missing = findActionIconsMissingAccessibleNames();
  assert.deepEqual(missing, [], `ActionIcon buttons need both title and aria-label: ${missing.join(", ")}`);
}

testSidebarKeepsGroupedInformationArchitecture();
testCustomerSubscriptionsPageCombinesRelatedWorkWithoutMergingBusinessLogic();
testSectionCardSupportsPageIntentAndActions();
testOverviewPrioritizesActionableWork();
testUsersPageKeepsAccountAndTeamEntrypoints();
testSubscriptionsPageKeepsSubscriptionActions();
testPlansAndAnnouncementsExposePageIntent();
testReleaseAndImageBedPagesExposePageIntent();
testPoliciesAndRuntimeComponentsUseCurrentNavigationNames();
testNodesPageKeepsNodeAndSyncTaskActions();
testProductionCopyUsesSyncTaskNaming();
testIconOnlyActionsHaveAccessibleNames();

console.log("admin information architecture regression checks passed");

// Calendar-month renewal preserves the intended expiry day where possible.
assert.equal(renewalDate("2026-01-31T13:10", 1), "2026-02-28T13:10");
assert.equal(renewalDate("2028-02-29T13:10", 12), "2029-02-28T13:10");
const renewalNow = new Date("2026-09-11T10:00:00");
assert.equal(renewalBase("2026-09-01T13:10:00", renewalNow), "2026-09-11T10:00");
assert.equal(renewalBase("2026-09-29T13:10:00", renewalNow), "2026-09-29T13:10");
