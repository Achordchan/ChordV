// A local-only endpoint fixture used by the real Rust updater integration test.
// No database, production server or installer process is involved.
import "reflect-metadata";
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ClientController } from "../src/modules/client/client.controller";
import { ReleaseCenterService } from "../src/modules/common/release-center.service";

const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/tauri-signature.json"), "utf8"));
const artifact = { id: "fixture", releaseId:"fixture", type:"setup_exe", source:"uploaded", storedFilePath:"fixture", deliveryMode:"desktop_installer_download", downloadUrl:"/api/downloads/releases/fixture", fileName:"fixture.exe", fileSizeBytes:BigInt(Buffer.byteLength(fixture.payload)), updaterSignature:fixture.signature, createdAt:new Date(), updatedAt:new Date(), isPrimary:true };
const releases: any = Object.create(ReleaseCenterService.prototype);
releases.findLatestPublishedRelease = async () => ({version:"99.0.0",minimumVersion:"0.0.0",forceUpgrade:false,changelog:[],publishedAt:new Date(),artifacts:[artifact]});
releases.downloadMirrorService = {getEffectiveConfig:async()=>({defaultMirrorPrefix:null,allowClientMirror:false})};
releases.assertStoredReleaseArtifactReadable = async () => {};
const controller: any = Object.create(ClientController.prototype);
controller.clientService = {checkUpdate:(input:unknown)=>releases.checkClientUpdate(input)};
const app = express();
app.get("/api/client/update/tauri", (req,res,next) => {
  controller.tauriUpdate({currentVersion:String(req.query.currentVersion || "0.1.0")},req,res).catch(next);
});
app.get("/api/downloads/releases/fixture", (_req,res) => res.type("application/octet-stream").send(fixture.payload));
const server = app.listen(0,"127.0.0.1",()=>{
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing local port");
  console.log(`http://127.0.0.1:${address.port}/api/client/update/tauri?currentVersion=0.1.0`);
});
