import "reflect-metadata";
import assert from "node:assert/strict";
import { Module, UnauthorizedException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { StorageController, CleanupDto, ReuseDto } from "../src/modules/admin/storage.controller";
import { StorageCatalogService } from "../src/modules/common/storage-catalog.service";
import { FileMaintenanceService } from "../src/modules/common/file-maintenance.service";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";
import { AdminAuthGuard } from "../src/modules/common/admin-auth.guard";
import { AuthSessionService } from "../src/modules/common/auth-session.service";
Reflect.defineMetadata("design:paramtypes",[StorageCatalogService,FileMaintenanceService,ReleaseCenterService],StorageController);
Reflect.defineMetadata("design:paramtypes",[CleanupDto],StorageController.prototype,"cleanup");
Reflect.defineMetadata("design:paramtypes",[ReuseDto],StorageController.prototype,"reuse");
Reflect.defineMetadata("design:paramtypes",[AuthSessionService],AdminAuthGuard);
let writes=0;
@Module({controllers:[StorageController],providers:[AdminAuthGuard,
  {provide:AuthSessionService,useValue:{authenticateAccessToken:async(token:string)=>{if(!token)throw new UnauthorizedException();return{id:"test",role:token==="Bearer admin"?"admin":"user"};}}},
  {provide:StorageCatalogService,useValue:{list:async()=>({items:[]}),cleanup:async()=>{writes++;return{ok:true};},scan:async(_signal:AbortSignal,progress:(v:unknown)=>void)=>{progress({checked:1,message:"扫描中"});return{items:[]};}}},
  {provide:FileMaintenanceService,useValue:{retry:async()=>({ok:true})}},
  {provide:ReleaseCenterService,useValue:{reuseReleaseArtifact:async()=>{writes++;return{id:"release"};}}}
]}) class TestModule{}
async function main(){const app=await NestFactory.create(TestModule,{logger:false});app.setGlobalPrefix("api");app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.listen(0,"127.0.0.1");try{
 const base=await app.getUrl();
 for(const token of [null,"Bearer user"]){const response=await fetch(`${base}/api/admin/storage`,{headers:token?{authorization:token}:{}});assert.equal(response.status,token?403:401);}
 const call=(route:string,body:unknown)=>fetch(`${base}/api/admin/storage/${route}`,{method:"POST",headers:{authorization:"Bearer admin","content-type":"application/json"},body:JSON.stringify(body)});
 assert.equal((await call("cleanup",{ids:"all"})).status,400);
 assert.equal((await call("cleanup",{ids:Array(101).fill("id")})).status,400);
 assert.equal((await call("reuse-release-file",{releaseId:5,sourceArtifactId:"id"})).status,400);
 assert.equal(writes,0);
 assert.equal((await call("reuse-release-file",{releaseId:"target",sourceArtifactId:"source",isPrimary:false})).status,201);
 const response=await call("scan",{});assert.match(response.headers.get("content-type")||"",/text\/event-stream/);const text=await response.text();assert.match(text,/"type":"progress"/);assert.match(text,/"type":"complete"/);
 console.log("storage admin authentication, DTO validation and SSE completion passed");
}finally{await app.close();}}
void main().catch(error=>{console.error(error);process.exitCode=1;});
