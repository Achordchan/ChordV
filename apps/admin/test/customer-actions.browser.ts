import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { customerActionsData } from "./fixtures/customer-actions-data";

test("真实App工作台提供团队转换、明确成员重置和团队范围断连",{timeout:90000},async t => {
  const server = await createServer({root:fileURLToPath(new URL("..",import.meta.url)),configFile:false,envFile:false,
    cacheDir:fileURLToPath(new URL("../../../.tmp/customer-actions-vite",import.meta.url)),
    resolve:{alias:{"@chordv/shared":fileURLToPath(new URL("../../../packages/shared/src/index.ts",import.meta.url))}},
    plugins:[react(),{name:"test-only-customer-actions",configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
      if(req.url?.split("?")[0]!=="/__customer-actions")return next();
      res.setHeader("Content-Type","text/html; charset=utf-8");res.end(await vite.transformIndexHtml(req.url!, '<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/fixtures/customer-actions.tsx"></script></body></html>'));
    });}}],server:{host:"127.0.0.1",port:0,strictPort:false}});
  t.after(()=>server.close());await server.listen();
  const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1024,height:768}}), data=customerActionsData();
  page.setDefaultTimeout(7000);
  const errors:string[]=[], external:string[]=[], posts:{path:string;body:Record<string,unknown>}[]=[];
  let noTeam=false,failConvert=true,failReset=true,failKick=true;
  page.on("pageerror",error=>errors.push(error.message));page.on("dialog",dialog=>void dialog.accept());
  await page.route("**/*",async route=>{
    const url=new URL(route.request().url()), pathname=url.pathname;
    if(url.hostname!=="127.0.0.1"){external.push(url.href);return route.abort("blockedbyclient");}
    if(!pathname.startsWith("/api/"))return route.continue();
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(pathname==="/api/auth/refresh")return json({accessToken:"component-only-token",refreshToken:"",user:{id:"admin",email:"admin@test.invalid",displayName:"测试管理员",role:"admin"}});
    if(pathname==="/api/admin/events/stream")return route.fulfill({status:200,contentType:"text/event-stream",body:'data: {"type":"keepalive"}\n\n'});
    if(route.request().method()==="POST") {
      const body=route.request().postDataJSON()??{};posts.push({path:pathname,body});
      await new Promise(resolve=>setTimeout(resolve,120));
      if(pathname.endsWith("/convert-to-team")){if(failConvert){failConvert=false;return json({message:"转换未完成，请重试。"},400);}return json({ok:true,deletedSubscriptionId:data.personal.id,teamId:data.team.id,teamName:data.team.name,teamSubscriptionId:data.shared.id,message:"个人订阅已停用，账号已转入团队。"});}
      if(pathname.endsWith("/reset-traffic")){if(failReset){failReset=false;return json({message:"成员流量暂不能重置。"},400);}return json({ok:true,subscriptionId:data.shared.id,userId:body.userId,subscription:data.shared,message:"流量已按节点最终结算边界重置。"});}
      if(pathname.endsWith("/kick")){if(failKick){failKick=false;return json({message:"本团队断连暂未完成。"},400);}if(body.disableAccount)await new Promise(resolve=>setTimeout(resolve,500));return json({ok:true,action:"disconnect_session",disconnectedSessionCount:1,accountDisabled:body.disableAccount,panelSyncStatus:"pending",message:"本团队连接已断开，成员仍保留在团队中。",reasonCode:body.disableAccount?"account_disabled":"admin_paused_connection",team:data.team,user:null});}
      throw new Error(`意外写请求 ${pathname}`);
    }
    const responses:Record<string,unknown>={"/api/admin/policies":data.policy,"/api/admin/dashboard":data.dashboard,"/api/admin/users":data.users,"/api/admin/plans":data.plans,"/api/admin/subscriptions":[data.personal,data.shared],"/api/admin/teams":noTeam?[]:[data.team],"/api/admin/nodes":[],"/api/admin/announcements":[],"/api/admin/nodes/lease-revocation-jobs":[],"/api/admin/nodes/node-command-jobs":data.queue,"/api/admin/presence":{generatedAt:data.timestamp,connectedWindowSeconds:150,onlineWindowSeconds:150,counts:{online:0,connected:0,idle:0},users:[]}};
    if(pathname.endsWith("/usage"))return json([]);
    if(pathname.endsWith("/nodes")&&pathname.includes("/subscriptions/"))return json({subscriptionId:pathname.split("/")[4],nodeIds:[],nodes:[]});
    if(pathname in responses)return json(responses[pathname]);
    return json({message:`测试未声明读取 ${pathname}`},404);
  });
  const open=async(team=false)=>{
    await page.goto(`${server.resolvedUrls!.local[0]}__customer-actions`);
    await page.locator(".admin-nav-menu").getByText("客户与订阅",{exact:true}).click();
    await expect(page.getByRole("heading",{name:"个人客户",exact:true})).toBeVisible();
    if(team){await page.getByRole("button",{name:"团队",exact:true}).click();await expect(page.getByRole("heading",{name:"测试团队",exact:true})).toBeVisible();}
  };
  const more=()=>page.getByRole("button",{name:"更多",exact:true}).click();
  await t.test("个人转换入口从当前工作台可达，缺目标禁用，错误可重试且成功关闭",async()=>{
    noTeam=true;await open();await more();await expect(page.getByRole("menuitem",{name:"转入团队订阅",exact:true})).toBeDisabled();
    noTeam=false;await open();await more();await page.getByRole("menuitem",{name:"转入团队订阅",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"转入团队订阅",exact:true});await expect(dialog).toBeVisible();
    await dialog.getByRole("button",{name:"确认转入团队",exact:true}).click();await expect(dialog).toContainText("转换未完成，请重试。");
    await dialog.getByRole("button",{name:"确认转入团队",exact:true}).click();await expect(dialog).toHaveCount(0);
    assert.deepEqual(posts.filter(item=>item.path.endsWith("/convert-to-team")).map(item=>item.body),[{targetTeamId:"team-a"},{targetTeamId:"team-a"}]);
  });
  await t.test("团队重置初始不选择成员、明确选定才提交，失败保留选择，成功关闭",async()=>{
    await open(true);await more();await page.getByRole("menuitem",{name:"重置成员流量",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"重置团队成员流量",exact:true}),submit=dialog.getByRole("button",{name:"重置所选成员流量",exact:true});
    await expect(dialog.getByRole("textbox",{name:"选择成员",exact:true})).toHaveValue("");await expect(submit).toBeDisabled();
    assert.equal(posts.filter(item=>item.path.endsWith("/reset-traffic")).length,0);
    await dialog.getByRole("textbox",{name:"选择成员",exact:true}).click();await page.getByRole("option",{name:/团队成员乙/}).click();
    await submit.click();await page.getByRole("button",{name:"确认重置",exact:true}).click();
    await expect(dialog).toContainText("成员流量暂不能重置。");await expect(dialog.getByRole("textbox",{name:"选择成员",exact:true})).toHaveValue(/团队成员乙/);
    await mkdir(fileURLToPath(new URL("../../../.tmp/ui-qa",import.meta.url)),{recursive:true});
    for(const [width,height] of [[1024,768],[390,640]]){await page.setViewportSize({width,height});await page.screenshot({path:fileURLToPath(new URL(`../../../.tmp/ui-qa/customer-team-reset-${width}.png`,import.meta.url))});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await page.setViewportSize({width:1024,height:768});await submit.click();await page.getByRole("button",{name:"确认重置",exact:true}).click();await expect(dialog).toHaveCount(0);
    assert.deepEqual(posts.filter(item=>item.path.endsWith("/reset-traffic")).map(item=>item.body),[{userId:"member-user"},{userId:"member-user"}]);
  });
  await t.test("成员详情重置明确传入当前成员，不发送空userId或默认其他成员",async()=>{
    await open(true);await page.getByRole("tab",{name:"团队成员",exact:true}).click();
    await page.getByRole("row").filter({hasText:"团队成员乙"}).getByRole("button",{name:"详情",exact:true}).click();
    await page.getByRole("dialog",{name:"成员详情",exact:true}).getByRole("button",{name:"重置成员流量",exact:true}).click();
    const confirmation=page.getByRole("dialog",{name:"重置订阅流量",exact:true});await expect(confirmation).toContainText("团队成员乙 · 测试团队");
    await expect(page.getByRole("dialog",{name:"重置团队成员流量",exact:true})).toHaveCount(0);
    await confirmation.getByRole("button",{name:"确认重置",exact:true}).click();await expect(confirmation).toHaveCount(0);
    await expect.poll(()=>posts.filter(item=>item.path.endsWith("/reset-traffic")).length).toBe(3);
    assert.deepEqual(posts.filter(item=>item.path.endsWith("/reset-traffic")).at(-1)?.body,{userId:"member-user"});
  });
  await t.test("成员详情用团队目标断连，失败保留、成功关闭，不调用全账号disconnect",async()=>{
    await open(true);await page.getByRole("tab",{name:"团队成员",exact:true}).click();
    const row=page.getByRole("row").filter({hasText:"团队成员乙"});await row.getByRole("button",{name:"详情",exact:true}).click();
    await page.getByRole("button",{name:"断开本团队连接",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"断开本 Team 连接",exact:true});await expect(dialog).toContainText("不会移出团队");
    await dialog.getByRole("button",{name:"确认断开本 Team 连接",exact:true}).dblclick({delay:20});await expect(dialog).toContainText("本团队断连暂未完成。");
    await dialog.getByRole("button",{name:"确认断开本 Team 连接",exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("row").filter({hasText:"团队成员乙"})).toHaveCount(1);
    const kicks=posts.filter(item=>item.path.endsWith("/kick"));assert.equal(kicks.length,2);assert.ok(kicks.every(item=>item.path==="/api/admin/teams/team-a/members/member-1/kick"&&item.body.disableAccount===false));
    assert.equal(posts.filter(item=>item.path.endsWith("/disconnect")).length,0);
  });
  await t.test("显式禁用账号展示全账号影响，提交中不能改选或关闭",async()=>{
    await open(true);await page.getByRole("tab",{name:"团队成员",exact:true}).click();
    await page.getByRole("row").filter({hasText:"团队成员乙"}).getByRole("button",{name:"详情",exact:true}).click();
    await page.getByRole("button",{name:"断开本团队连接",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"断开本 Team 连接",exact:true}), checkbox=dialog.getByRole("checkbox",{name:"同时禁用这个账号",exact:true});
    const id=await checkbox.getAttribute("id");await dialog.locator(`label[for="${id}"]`).click();
    await expect(dialog).toContainText("断开该账号在所有订阅和团队下的连接");await expect(dialog).not.toContainText("不会影响个人订阅");
    await dialog.getByRole("button",{name:"禁用账号并断开所有连接",exact:true}).click();
    await expect(checkbox).toBeDisabled();await expect(dialog.getByRole("button",{name:"取消",exact:true})).toBeDisabled();
    await expect(dialog.locator("button.mantine-Modal-close")).toHaveCount(0);await page.keyboard.press("Escape");await expect(dialog).toBeVisible();await expect(dialog).toHaveCount(0);
    assert.deepEqual(posts.filter(item=>item.path.endsWith("/kick")).at(-1)?.body,{disableAccount:true});
  });
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
