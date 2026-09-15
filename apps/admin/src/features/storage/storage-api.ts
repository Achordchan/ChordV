import { request, requestResponse } from "../../api/base";
export type StorageEntry = { id:string;name:string;category:string;sizeBytes:number;allocatedBytes:number;references:string[];state:"referenced"|"orphan"|"protected"|"missing";canCleanup:boolean;hash:string|null;modifiedAt:string|null;links:number };
export type StorageSnapshot = { diskFreeBytes?:number|null;scannedAt:string|null;logicalBytes:number;allocatedBytes:number;hardlinkSavedBytes:number;reusableBytes:number;totalFiles:number;orphanCount:number;missingCount:number;warnings:string[];items:StorageEntry[];hasMore:boolean;cleanupTotal:number;cleanupJobs:Array<{blocked:boolean;id:string;path:string;reason:string;attempts:number;lastError:string|null;nextAttemptAt:string}> };
export const listStorage=(page=0,search="",cleanupPage=0)=>request<StorageSnapshot>(`/admin/storage?page=${page}&search=${encodeURIComponent(search)}&cleanupPage=${cleanupPage}`);
export async function scanStorage(signal:AbortSignal,onProgress:(message:string)=>void) {
  const response=await requestResponse("/admin/storage/scan",{method:"POST",signal,timeoutMs:10*60_000});
  if(!response.body)throw new Error("扫描连接中断");
  const reader=response.body.getReader(), decoder=new TextDecoder();let buffer="";
  try{while(true){const {done,value}=await reader.read();if(done)throw new Error("扫描尚未完成，连接已中断");buffer+=decoder.decode(value,{stream:true});if(buffer.length>4*1024*1024)throw new Error("扫描响应超出限制");let end:number;while((end=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()).join("\n");if(!data)continue;const event=JSON.parse(data);if(event.type==="progress")onProgress(`${event.message} · 已检查 ${event.checked} 个文件`);if(event.type==="error")throw new Error(event.message);if(event.type==="complete")return event.snapshot as StorageSnapshot;}}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
