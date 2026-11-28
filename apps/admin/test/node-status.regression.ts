import assert from "node:assert/strict";
import type { AdminNodeRecordDto } from "@chordv/shared";
import { compactNodeStatus, nodeAttention } from "../src/utils/node-status";
import { translateAgentStatus } from "../src/utils/admin-translate";

const node = (status?: string, xrayStatus = "healthy", probeStatus = "healthy", controlStatus = "healthy") => ({
  isActive:true,registrationStatus:"agent_ready",controlStatus,probeStatus,
  agent:status ? {status,xrayStatus} : null
} as unknown as AdminNodeRecordDto);

assert.deepEqual(compactNodeStatus(node("online")),{color:"green",label:"Agent 在线"},"真实Go DTO的内核healthy不能遮蔽Agent online");
assert.deepEqual(compactNodeStatus(node("online","healthy","unknown")),{color:"green",label:"Agent 在线"},"未检测TCP不是缺失心跳");
assert.deepEqual(compactNodeStatus(node("offline")),{color:"red",label:"Agent 离线"});
assert.deepEqual(compactNodeStatus(node("degraded")),{color:"yellow",label:"Agent 异常"});
assert.deepEqual(compactNodeStatus(node(undefined)),{color:"gray",label:"Agent 等待心跳"},"无Agent不能仅凭内核healthy判在线");
assert.deepEqual(compactNodeStatus(node(undefined,"healthy","healthy","online")),{color:"gray",label:"Agent 等待心跳"},"controlStatus不是Agent在线证据");
assert.deepEqual(compactNodeStatus(node("online","degraded")),{color:"yellow",label:"Xray 异常"});
assert.deepEqual(compactNodeStatus(node("online","offline")),{color:"red",label:"Xray 离线"});
assert.deepEqual(compactNodeStatus(node("online","awaiting_inbound")),{color:"gray",label:"Xray 等待绑定入站"});
assert.deepEqual(compactNodeStatus(node("online","unknown")),{color:"gray",label:"Xray 未知"});
assert.deepEqual(compactNodeStatus(node("online","healthy","offline")),{color:"red",label:"离线"});
assert.deepEqual(compactNodeStatus({...node("offline"),isActive:false}),{color:"gray",label:"已禁用"});
assert.equal(translateAgentStatus("healthy"),"等待心跳","禁止通过把内核healthy译成Agent在线掩盖字段混用");
for (const [value,expected] of [
  [node("online"),2],[node("online","healthy","unknown"),2],
  [node("offline"),0],[node("degraded"),0],[node(undefined),1],
  [node("online","degraded"),0],[node("online","offline"),0],
  [node("online","awaiting_inbound"),1],[node("online","unknown"),1],
  [node("online","healthy","offline"),0],[{...node("offline"),isActive:false},3]
] as const) assert.equal(nodeAttention(value),expected);
console.log("node status DTO separation regression checks passed");
