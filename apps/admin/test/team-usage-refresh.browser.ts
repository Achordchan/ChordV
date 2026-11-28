import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import net from "node:net";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { customerActionsData } from "./fixtures/customer-actions-data";

test("实际App通过SSE同步已加载团队用量，不重建成员弹窗或接受旧usage响应",{timeout:60000},async t=>{
  const data=customerActionsData(),streams=new Set<ServerResponse>(),errors:string[]=[];
  let usageRequests=0,unopenedRequests=0,teamRequests=0,sequence=0,holdUsage=false;
  let delayed:{response:ServerResponse;body:string}|null=null;
  const usage=(owner:number,member:number)=>data.team.members.map((entry,index)=>({id:`usage-${entry.id}`,teamId:data.team.id,userId:entry.userId,userDisplayName:entry.displayName,userEmail:entry.email,subscriptionId:data.shared.id,usedTrafficGb:index?member:owner,memberTotalUsedTrafficGb:index?member:owner,recordCount:2,recordedAt:data.timestamp,nodeBreakdown:[]}));
  let currentUsage=usage(.01,.02);
  const listener=net.createServer();await new Promise<void>(resolve=>listener.listen(0,"127.0.0.1",resolve));
  const port=(listener.address() as net.AddressInfo).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const respond=(response:ServerResponse,value:unknown,status=200)=>{response.writeHead(status,{"Content-Type":"application/json"});response.end(JSON.stringify(value));};
  const server=await createServer({root:fileURLToPath(new URL("..",import.meta.url)),configFile:false,envFile:false,
    cacheDir:fileURLToPath(new URL("../../../.tmp/team-usage-refresh-vite",import.meta.url)),resolve:{alias:{"@chordv/shared":fileURLToPath(new URL("../../../packages/shared/src/index.ts",import.meta.url))}},
    plugins:[react(),{name:"test-only-team-usage-refresh",configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
      const pathname=req.url?.split("?")[0]??"";
      if(pathname==="/__team-usage-refresh"){res.setHeader("Content-Type","text/html; charset=utf-8");return res.end(await vite.transformIndexHtml(req.url!,'<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/fixtures/customer-actions.tsx"></script></body></html>'));}
      if(!pathname.startsWith("/api/"))return next();
      if(pathname==="/api/admin/events/stream"){res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"});res.write('data: {"type":"keepalive"}\n\n');streams.add(res);req.once("close",()=>streams.delete(res));return;}
      if(pathname==="/api/auth/refresh")return respond(res,{accessToken:"usage-component-only-token",refreshToken:"",user:{id:"admin",email:"admin@test.invalid",role:"admin"}});
      if(pathname==="/api/admin/teams/team-a/usage"){usageRequests++;if(holdUsage){delayed={response:res,body:JSON.stringify(currentUsage)};return;}return respond(res,currentUsage);}
      if(pathname==="/api/admin/teams/team-unopened/usage"){unopenedRequests++;return respond(res,[]);}
      if(pathname==="/api/admin/teams"){teamRequests++;return respond(res,[{...data.team,usage:currentUsage},{...data.team,id:"team-unopened",name:"未打开的团队",usage:[]}]);}
      if(pathname.endsWith("/nodes")&&pathname.includes("/subscriptions/"))return respond(res,{subscriptionId:pathname.split("/")[4],nodeIds:[],nodes:[]});
      const responses:Record<string,unknown>={"/api/admin/policies":data.policy,"/api/admin/dashboard":data.dashboard,"/api/admin/users":data.users,"/api/admin/plans":data.plans,"/api/admin/subscriptions":[data.personal,data.shared],"/api/admin/nodes":[],"/api/admin/announcements":[],"/api/admin/nodes/lease-revocation-jobs":[],"/api/admin/nodes/node-command-jobs":data.queue,"/api/admin/presence":{generatedAt:data.timestamp,connectedWindowSeconds:150,onlineWindowSeconds:150,counts:{online:0,connected:0,idle:0},users:[]}};
      if(pathname in responses)return respond(res,responses[pathname]);
      return respond(res,{message:`测试未声明请求 ${pathname}`},404);
    });}}],server:{host:"127.0.0.1",port,strictPort:true}});
  await server.listen();const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL});
  t.after(async()=>{delayed?.response.end();for(const response of streams)response.end();await browser.close();await server.close();});
  const page=await browser.newPage({viewport:{width:1024,height:768}});page.setDefaultTimeout(6000);
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort("blockedbyclient"));
  const open=async()=>{await page.goto(`${server.resolvedUrls!.local[0]}__team-usage-refresh`);await page.locator(".admin-nav-menu").getByText("客户与订阅",{exact:true}).click();await page.getByRole("button",{name:"团队",exact:true}).click();await page.getByRole("tab",{name:"团队成员",exact:true}).click();};
  const memberRow=()=>page.locator("tr").filter({hasText:"团队成员乙"});
  const push=()=>{for(const response of streams)response.write(`id: usage-${++sequence}\ndata: {"type":"subscription_updated"}\n\n`);};

  await t.test("SSE更新原位刷新累计用量，保留成员Modal与滚动，不额外请求usage",async()=>{
    await open();await expect(memberRow()).toContainText("0.02 GB");await expect.poll(()=>streams.size).toBe(1);
    await memberRow().getByRole("button",{name:"详情",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"成员详情",exact:true}), original=await dialog.elementHandle(),table=await page.locator("table").first().elementHandle();
    await expect(dialog).toContainText("0.02 GB");await dialog.hover();await page.mouse.wheel(0,180);
    await expect.poll(()=>dialog.evaluate(element=>Math.max(element.scrollTop,...[...element.querySelectorAll<HTMLElement>("*")].map(item=>item.scrollTop)))).toBeGreaterThan(0);
    const scroller=await dialog.evaluateHandle(element=>[element,...element.querySelectorAll<HTMLElement>("*")].find(item=>item.scrollTop>0)??element);
    const scrollBefore=await scroller.evaluate(element=>element.scrollTop);
    const readBefore=teamRequests,usageBefore=usageRequests;
    currentUsage=usage(.012,.023);for(let i=0;i<50;i++)push();
    await expect.poll(()=>teamRequests).toBeGreaterThan(readBefore);
    await expect(memberRow()).toContainText("0.023 GB");await expect(dialog).toContainText("0.023 GB");
    assert.equal(await original!.evaluate(element=>element.isConnected),true);assert.equal(await table!.evaluate(element=>element.isConnected),true);
    assert.equal(await scroller.evaluate(element=>element.scrollTop),scrollBefore);assert.equal(usageRequests,usageBefore);assert.equal(unopenedRequests,0);
    await mkdir(fileURLToPath(new URL("../../../.tmp/ui-qa",import.meta.url)),{recursive:true});await page.screenshot({path:fileURLToPath(new URL("../../../.tmp/ui-qa/team-usage-sse-preserved.png",import.meta.url))});
  });
  for(const failure of [false,true])await t.test(`首次usage在途时收到新teams快照，旧${failure?"失败":"成功"}不得回灌`,async()=>{
    currentUsage=usage(.01,.02);holdUsage=true;delayed=null;const previous=usageRequests;await open();await expect.poll(()=>usageRequests).toBe(previous+1);
    currentUsage=usage(.04,.08);push();await expect(memberRow()).toContainText("0.08 GB");
    const response=page.waitForResponse(answer=>answer.url().endsWith("/api/admin/teams/team-a/usage"));
    const pending=delayed as unknown as {response:ServerResponse;body:string};assert.ok(pending);
    pending.response.writeHead(failure?500:200,{"Content-Type":"application/json"});pending.response.end(failure?JSON.stringify({message:"旧请求失败"}):pending.body);delayed=null;holdUsage=false;
    await (await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(memberRow()).toContainText("0.08 GB");await expect(page.getByText("旧请求失败",{exact:false})).toHaveCount(0);await expect(page.getByRole("columnheader",{name:"累计已用",exact:true})).toBeVisible();
    assert.equal(unopenedRequests,0);
  });
  assert.deepEqual(errors,[]);
});
