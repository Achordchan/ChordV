import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const adminSrcRoot = resolve(import.meta.dirname, "../src");
const appSource = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");
const customerSubscriptionsPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/CustomerSubscriptionsPage.tsx"), "utf8");
const sectionCardSource = readFileSync(resolve(import.meta.dirname, "../src/features/shared/SectionCard.tsx"), "utf8");
const overviewPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/OverviewPage.tsx"), "utf8");
const usersPageSource = readFileSync(resolve(import.meta.dirname, "../src/pages/UsersPage.tsx"), "utf8");
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
          if (!names.has("title") || !names.has("aria-label")) {
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
  for (const title of ["总览", "用户与订阅", "节点与任务", "客服与公告", "应用发布", "系统设置"]) {
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
  assert.match(appSource, />\s*后台工具\s*</);
  assert.match(appSource, />\s*同步任务\s*</);
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
  assert.ok(
    overviewPageSource.indexOf("待处理事项") < overviewPageSource.indexOf("用户数"),
    "overview should show actionable work before passive metrics"
  );
  assert.match(overviewPageSource, /title="后台同步任务"/);
  assert.match(overviewPageSource, /actionLabel="查看同步任务"/);
  assert.doesNotMatch(overviewPageSource, /优先处理工单、后台同步和异常节点。/);
  assert.doesNotMatch(overviewPageSource, /用户正在等待管理员回复。/);
}

function testUsersPageKeepsAccountAndTeamEntrypoints() {
  assert.match(usersPageSource, /title="客户与团队"/);
  assert.doesNotMatch(usersPageSource, /个人账号、团队关系和账号级连接动作集中在这里处理。/);
  assert.match(usersPageSource, /searchPlaceholder="搜索邮箱、名称或团队"/);
  assert.match(usersPageSource, /当前订阅/);
  assert.match(usersPageSource, /流量 \/ 节点/);
  assert.match(usersPageSource, /使用情况/);
  assert.match(usersPageSource, /<Table\.Th>详情<\/Table\.Th>/);
  assert.match(usersPageSource, /<CustomerDetailDrawer/);
  assert.match(usersPageSource, /<Drawer opened=\{props\.target !== null\}/);
  assert.match(usersPageSource, /<DrawerSection title="订阅与节点">/);
  assert.match(usersPageSource, /<DrawerSection title="账号操作">/);
  assert.match(usersPageSource, /<DrawerSection title="团队关系">/);
  assert.match(usersPageSource, /<MemberUsageCell/);
  assert.match(usersPageSource, /props\.onLoadTeamUsage\(item\.id\)/);
  assert.match(usersPageSource, /props\.onOpenTeamUsageDetail/);
  assert.match(appSource, /teamUsageByTeamId=\{teamUsageByTeamId\}/);
  assert.match(appSource, /onOpenTeamUsageDetail=\{setTeamUsageDetailTarget\}/);
  assert.match(usersPageSource, /props\.onOpenRenewDrawer\(props\.subscriptionId!\)/);
  assert.match(usersPageSource, /props\.onOpenChangePlanDrawer\(props\.subscriptionId!\)/);
  assert.match(usersPageSource, /props\.onOpenNodeAccessEditor\(props\.subscriptionId!, props\.ownerLabel\)/);
  assert.match(usersPageSource, /props\.onResetSubscriptionTraffic\(subscriptionId, user\.displayName \|\| user\.email\)/);
  assert.match(usersPageSource, /<TeamSubscriptionSummary/);
  assert.match(usersPageSource, /<TeamSubscriptionActions/);
  assert.match(usersPageSource, /个人用户 · \{personalUsers\.length\}/);
  assert.match(usersPageSource, /团队管理 · \{props\.filteredTeams\.length\}/);
  assert.match(usersPageSource, /onOpenUserDrawer\(user\.id\)/);
  assert.match(usersPageSource, /onCreateSubscriptionForUser\(user\)/);
  assert.match(usersPageSource, /onDisconnectUser\(user\.id, user\.displayName, "personal"\)/);
  assert.match(usersPageSource, /onToggleUserStatus/);
  assert.match(usersPageSource, /props\.onOpenTeamSubscriptions\(props\.team\)/);
  assert.match(usersPageSource, /onOpenTeamInlineEditor\(team\.id\)/);
  assert.match(usersPageSource, /onOpenTeamMemberInlineEditor\(team\.id\)/);
  assert.match(usersPageSource, /onDeleteTeamMember\(team\.id, member\.id\)/);
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
  assert.match(plansPageSource, /title="套餐规则"/);
  assert.match(plansPageSource, /searchPlaceholder="搜索套餐名称"/);
  assert.match(plansPageSource, /个人套餐 · \{personalPlans\.length\}/);
  assert.match(plansPageSource, /Team 套餐 · \{teamPlans\.length\}/);
  assert.match(plansPageSource, /onOpenPlanDrawer\(item\.id\)/);
  assert.match(plansPageSource, /title="编辑套餐" aria-label="编辑套餐"/);

  assert.match(announcementsPageSource, /title="公告管理"/);
  assert.match(announcementsPageSource, /searchPlaceholder="搜索公告标题或内容"/);
  assert.match(announcementsPageSource, /onOpenAnnouncementDrawer\(item\.id\)/);
  assert.match(announcementsPageSource, /onDeleteAnnouncement\(item\.id\)/);
  assert.match(announcementsPageSource, /title="编辑公告"/);
  assert.match(announcementsPageSource, /aria-label="编辑公告"/);
  assert.match(announcementsPageSource, /title="删除公告"/);
  assert.match(announcementsPageSource, /aria-label="删除公告"/);
}

function testReleaseAndImageBedPagesExposePageIntent() {
  assert.match(releasesPageSource, /title="发布中心"/);
  assert.doesNotMatch(releasesPageSource, /管理客户端版本、安装包、外链下载和发布状态。/);
  assert.match(releasesPageSource, /searchPlaceholder="搜索版本、标题或更新内容"/);
  assert.match(releasesPageSource, /openCreateRelease/);
  assert.match(releasesPageSource, /loadReleases\(\)/);

  assert.match(imageBedPageSource, /title="附件图床配置"/);
  assert.doesNotMatch(imageBedPageSource, /配置工单附件图床 Token，并管理已上传图片。/);
  assert.match(imageBedPageSource, /searchPlaceholder="搜索图床文件"/);
  assert.match(imageBedPageSource, /onSearchSubmit=\{\(\) => void loadFiles\(\)\}/);
  assert.match(imageBedPageSource, /handleSave/);
  assert.match(imageBedPageSource, /handleDelete/);
}

function testPoliciesAndRuntimeComponentsUseCurrentNavigationNames() {
  assert.match(policiesPageSource, /<Title order=\{4\}>连接策略<\/Title>/);
  assert.doesNotMatch(policiesPageSource, /配置客户端默认连接模式、可选模式和基础分流规则。/);
  assert.doesNotMatch(policiesPageSource, /当前使用 3x-ui 直连接入/);
  assert.doesNotMatch(policiesPageSource, /接入与连接策略/);

  assert.match(runtimeComponentsPageSource, /加载客户端组件失败/);
  assert.match(runtimeComponentsPanelSource, /<Title order=\{4\}>客户端组件<\/Title>/);
  assert.match(runtimeComponentsPanelSource, /客户端组件请求状态不确定/);
  assert.match(runtimeComponentsPanelSource, /title="编辑客户端组件"/);
  assert.match(runtimeComponentsPanelSource, /aria-label="编辑客户端组件"/);
  assert.match(runtimeComponentsPanelSource, /title="复制最终下载地址"/);
  assert.match(runtimeComponentsPanelSource, /aria-label="复制最终下载地址"/);
  assert.match(runtimeComponentEditorSource, /编辑客户端组件/);
}

function testNodesPageKeepsNodeAndSyncTaskActions() {
  assert.match(nodesPageSource, /title="节点与同步"/);
  assert.match(nodesPageSource, /searchPlaceholder="搜索节点、地区或地址"/);
  assert.match(nodesPageSource, />\s*同步任务\s*</);
  assert.match(nodesPageSource, /<Table\.Th>同步任务<\/Table\.Th>/);
  assert.match(nodesPageSource, /onProbeNode\(item\.id\)/);
  assert.match(nodesPageSource, /onRefreshNode\(item\.id\)/);
  assert.match(nodesPageSource, /onOpenNodeDrawer\(item\.id\)/);
  assert.match(nodesPageSource, /onDeleteNode\(item\)/);
  assert.match(nodesPageSource, /onOpenPanelSyncQueue\(\{ nodeId: props\.node\.id, title: props\.node\.name \}\)/);
  assert.match(nodesPageSource, /onRetryNodePanelSyncJobs\(props\.node\.id\)/);
  assert.match(nodesPageSource, /onRetryNodeLeaseRevocationJobs\(props\.node\.id\)/);
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
