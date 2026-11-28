import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["submitDrawer", "closeDrawer", "forceCloseDrawer"];
const functions = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) functions.set(node.name.text, node.getText(file));
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(functions.size, names.length);
const emitted = ts.transpileModule([...functions.values()].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
for (const recordId of [null, "existing-announcement"]) {
  for (const success of [true, false]) {
    const busy = { current: false }, closed: unknown[] = [], writes: string[] = [];
    const api = vm.runInNewContext(`${emitted}\n({submitDrawer,closeDrawer})`, {
      drawer: { type: "announcement", recordId }, snapshot: {}, drawerBusyRef: busy,
      announcementForm: { title: "本地公告", body: "正文", level: "info", publishedAt: "2026-11-17T01:00", isActive: true, displayMode: "passive", countdownSeconds: 0 },
      setDrawer: (value: unknown) => closed.push(value), setDrawerBusy() {},
      fromDateTimeLocal: (value: string) => new Date(value).toISOString(), dbFirstMutationOptions: {},
      createAnnouncement: async () => writes.push("create"),
      updateAnnouncement: async (id: string) => writes.push(id),
      runAction: async (operation: () => Promise<unknown>) => { await operation(); return success; }
    }) as { submitDrawer(): Promise<void>; closeDrawer(): void };
    busy.current = true;
    api.closeDrawer();
    assert.equal(closed.length, 0, "在途保存期间的用户关闭操作仍须被拦截");
    busy.current = false;
    await api.submitDrawer();
    assert.deepEqual(writes, [recordId ?? "create"]);
    assert.equal(closed.length, success ? 1 : 0, "公告保存成功必须关闭；保存失败必须保留编辑器");
    assert.equal(busy.current, false, "无论结果如何都要释放提交状态");
  }
}
console.log("announcement save lifecycle behavior passed");
