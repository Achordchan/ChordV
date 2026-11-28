// Test-only DTO fixtures, not proof of database mutations or physical Agent results.
export function customerActionsData() {
  const timestamp = "2026-11-17T00:00:00Z", expiry = "2099-11-17T00:00:00Z";
  const personal = {id:"personal-sub",userId:"personal-user",teamId:null,ownerType:"user",planId:"personal-plan",planName:"个人套餐",userEmail:"personal@test.invalid",userDisplayName:"个人客户",totalTrafficGb:10,usedTrafficGb:2,remainingTrafficGb:8,expireAt:expiry,state:"active",renewable:true,sourceAction:"created",nodeCount:0,hasNodeAccess:false,lastSyncedAt:timestamp};
  const shared = {...personal,id:"team-sub",userId:null,teamId:"team-a",ownerType:"team",planId:"team-plan",planName:"团队套餐",teamName:"测试团队",totalTrafficGb:40,remainingTrafficGb:38};
  const user = (id:string,displayName:string,accountType:string) => ({id,displayName,email:`${id}@test.invalid`,role:"user",status:"active",accountType,teamId:accountType === "team" ? "team-a" : null,teamName:"测试团队",subscriptionCount:1,activeSubscriptionCount:1,currentSubscription:accountType === "team" ? shared : personal,clientVersions:[],createdAt:timestamp,updatedAt:timestamp});
  const users = [user("personal-user","个人客户","personal"),user("owner-user","团队负责人","team"),user("member-user","团队成员乙","team")];
  const members = users.slice(1).map((entry,index) => ({id:`member-${index}`,teamId:"team-a",userId:entry.id,displayName:entry.displayName,email:entry.email,role:index===0?"owner":"member",usedTrafficGb:index+1,createdAt:timestamp,updatedAt:timestamp}));
  const team = {id:"team-a",name:"测试团队",ownerUserId:"owner-user",ownerDisplayName:"团队负责人",ownerEmail:users[1].email,status:"active",memberCount:2,members,currentSubscription:shared,usage:[],createdAt:timestamp,updatedAt:timestamp};
  const plans = [{id:"personal-plan",name:"个人套餐",scope:"personal",totalTrafficGb:10,renewable:true,maxConcurrentSessions:3,isActive:true,subscriptionCount:1,createdAt:timestamp,updatedAt:timestamp},{id:"team-plan",name:"团队套餐",scope:"team",totalTrafficGb:40,renewable:true,maxConcurrentSessions:3,isActive:true,subscriptionCount:1,createdAt:timestamp,updatedAt:timestamp}];
  const queue = {jobs:[],summaries:{nodes:[],subscriptions:[],users:[],teams:[]}};
  const policy = {defaultMode:"rule",modes:["rule","global","direct"],features:{blockAds:true,chinaDirect:true,aiServicesProxy:true},customRoutingRules:[]};
  const dashboard = {users:3,teams:1,activeSubscriptions:2,activeNodes:0,announcements:0,activePlans:2,openTickets:0,waitingAdminTickets:0,closedTickets:0,legacyTicketsReadOnly:false};
  return {personal,shared,users,team,plans,queue,policy,dashboard,timestamp};
}
