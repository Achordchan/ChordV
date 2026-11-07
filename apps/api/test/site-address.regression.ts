import "reflect-metadata";
import assert from "node:assert/strict";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { SiteAddressService, normalizeSiteOrigin } from "../src/modules/common/site-address.service";
import { SiteAddressController, ClientSiteAddressController } from "../src/modules/admin/site-address.controller";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { siteAddressContext, publicSiteOrigin } from "../src/modules/common/site-address.context";
import { buildReleaseArtifactDownloadUrl, resolveReleaseArtifactForClient } from "../src/modules/common/release-center.utils";
import { runtimeVersionUrl } from "../src/modules/common/runtime-version-files";
import { isAllowedCorsOrigin } from "../src/cors";
import { needsLegacyComponentManagement } from "../../admin/src/features/runtime-components/legacy-component-policy";

async function main() {
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA,SiteAddressController),[AdminAuthGuard]);
  assert.equal(Reflect.getMetadata(GUARDS_METADATA,ClientSiteAddressController),undefined);
  for(const value of ["http://remote.example","https://u:p@example.com","https://example.com/path","https://example.com?q=1","javascript:alert(1)"]) {
    assert.throws(()=>normalizeSiteOrigin(value));
  }
  let saved:any=null;
  const service=new SiteAddressService({systemSetting:{
    findUnique:async()=>saved,
    upsert:async({create,update}:any)=>saved={...create,...update,updatedAt:new Date("2026-09-14T00:00:00Z")}
  }} as never);
  const originalEnv=process.env.CHORDV_PUBLIC_BASE_URL;
  process.env.CHORDV_PUBLIC_BASE_URL="https://old.example";
  try {
    assert.equal((await service.get()).primaryOrigin,"https://old.example");
    const config=await service.save({primaryOrigin:" https://NEW.example/ ",legacyOrigins:["https://old.example/","https://old.example","https://new.example"]});
    assert.deepEqual(config.legacyOrigins,["https://old.example"]);
    assert.equal((await service.get()).primaryOrigin,"https://new.example");
    assert.equal(process.env.CHORDV_PUBLIC_BASE_URL,"https://old.example","保存配置不能改进程环境");
    await Promise.all([config,{...config,primaryOrigin:"https://second.example"}].map(value=>siteAddressContext.run(value,async()=>{
      await new Promise(resolve=>setTimeout(resolve,1));
      assert.equal(publicSiteOrigin(),value.primaryOrigin);
      assert.ok(buildReleaseArtifactDownloadUrl("artifact").startsWith(value.primaryOrigin));
      assert.ok(runtimeVersionUrl("version").startsWith(value.primaryOrigin));
      assert.equal(isAllowedCorsOrigin(value.primaryOrigin),true);
      assert.equal(isAllowedCorsOrigin("https://old.example"),true);
      assert.equal(isAllowedCorsOrigin("https://untrusted.example"),false);
      const uploaded=resolveReleaseArtifactForClient({id:"artifact",source:"uploaded",downloadUrl:"https://old.example/previous"} as never,null);
      assert.ok(uploaded.downloadUrl.startsWith(value.primaryOrigin));
      const external=resolveReleaseArtifactForClient({id:"artifact",source:"external",downloadUrl:"https://external.example/file.zip"} as never,null);
      assert.equal(external.downloadUrl,"https://external.example/file.zip");
    })));
    assert.equal(publicSiteOrigin(),"https://old.example","请求结束后恢复环境默认值");
  } finally {if(originalEnv===undefined)delete process.env.CHORDV_PUBLIC_BASE_URL;else process.env.CHORDV_PUBLIC_BASE_URL=originalEnv;}
  {
    const prevDl=process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL;
    try {
      const hash="b".repeat(64);
      siteAddressContext.run({primaryOrigin:"https://v.example.com"} as never,()=>{
        delete process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL;
        assert.equal(buildReleaseArtifactDownloadUrl("artifact_1",hash),"https://v.example.com/api/downloads/releases/artifact_1?v="+"b".repeat(16));
        assert.equal(buildReleaseArtifactDownloadUrl("artifact_1"),"https://v.example.com/api/downloads/releases/artifact_1");
        process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL="https://dl.example.com/";
        assert.equal(buildReleaseArtifactDownloadUrl("artifact_1",hash),"https://dl.example.com/api/downloads/releases/artifact_1?v="+"b".repeat(16));
        assert.equal(runtimeVersionUrl("00000000-0000-0000-0000-000000000000"),"https://dl.example.com/api/downloads/runtime-versions/00000000-0000-0000-0000-000000000000");
        assert.equal(publicSiteOrigin(),"https://v.example.com");
        for(const bad of ["https://dl.example.com:443x","https://u:p@dl.example.com","https://dl.example.com/sub","https://dl.example.com?x=1","ftp://dl.example.com"]){
          process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL=bad;
          assert.equal(buildReleaseArtifactDownloadUrl("artifact_1"),"https://v.example.com/api/downloads/releases/artifact_1",bad);
        }
        process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL="dl.example.com/path";
        assert.equal(buildReleaseArtifactDownloadUrl("artifact_1","not-a-hash"),"https://v.example.com/api/downloads/releases/artifact_1");
      });
    } finally {if(prevDl===undefined)delete process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL;else process.env.CHORDV_PUBLIC_DOWNLOAD_BASE_URL=prevDl;}
  }
  assert.equal(needsLegacyComponentManagement([{enabled:true,active:null}]),true);
  assert.equal(needsLegacyComponentManagement([{enabled:true,managed:true,active:{id:"version",status:"ready"}},{enabled:false,active:null}]),false);
  assert.equal(needsLegacyComponentManagement([{enabled:true,managed:true,active:{status:"failed"}}]),true);
  assert.equal(needsLegacyComponentManagement([]),false);
  console.log("site addresses, request isolation, generated links and retirement checks passed");
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
