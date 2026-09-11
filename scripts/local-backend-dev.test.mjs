import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// The supervisor runs unchanged; only child processes and HTTP are simulated.
// No server, database, package download or user's local environment is touched.
function run(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'chordv-supervisor-'));
  try {
    mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'node_modules/concurrently'),{recursive:true});
    copyFileSync(fileURLToPath(new URL('./local-backend-dev.mjs',import.meta.url)),join(dir,'scripts/local-backend-dev.mjs'));
    writeFileSync(join(dir,'node_modules/concurrently/package.json'),JSON.stringify({type:'module',exports:'./index.js'}));
    writeFileSync(join(dir,'node_modules/concurrently/index.js'), `
      export default function concurrently(input, options) {
        console.log(JSON.stringify({input, options, agentId:process.env.CHORDV_AGENT_ID, api:process.env.CHORDV_API_BASE_URL}));
        let resolve;
        const result = process.env.TEST_SCENARIO === 'child-failed' ? Promise.reject(new Error('child failed')) : new Promise(r => resolve=r);
        if(['ready','agent'].includes(process.env.TEST_SCENARIO)) setTimeout(()=>resolve([]),40);
        return {result, commands:input.map(()=>({close:{subscribe(){return {unsubscribe(){}};}},kill(signal){console.log('stop:'+signal);resolve?.([]);}}))};
      }
    `);
    writeFileSync(join(dir,'setup.mjs'), `
      globalThis.fetch = async (url) => {
        console.log('probe:'+url);
        return {ok:['ready','agent','real-child'].includes(process.env.TEST_SCENARIO),headers:new Map([['content-type','text/html']]),body:{cancel:async()=>{}},json:async()=>({status:'ready'})};
      };
      if(process.env.TEST_SCENARIO==='timeout'){let now=0;Date.now=()=>now+=50000;}
    `);
    if(mode==='real-child') {
      const entry=createRequire(import.meta.url).resolve('concurrently');
      writeFileSync(join(dir,'node_modules/concurrently/index.js'),'export {default} from '+JSON.stringify(pathToFileURL(entry).href)+';');
      mkdirSync(join(dir,'bin'));
      writeFileSync(join(dir,'bin/corepack'),'#!/bin/sh\ncase "$*" in\n*dev:prepared*) exec '+JSON.stringify(process.execPath)+' -e "setTimeout(() => process.exit(1), 250)";;\n*) exec '+JSON.stringify(process.execPath)+' -e "setInterval(() => {}, 1000)";;\nesac\n');chmodSync(join(dir,'bin/corepack'),0o755);
      return spawnSync(process.execPath,['--import',join(dir,'setup.mjs'),join(dir,'scripts/local-backend-dev.mjs')],{encoding:'utf8',timeout:5000,env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,CHORDV_ADMIN_PORT:'5188',TEST_SCENARIO:mode}});
    }
    if(mode==='agent') {
      copyFileSync(fileURLToPath(new URL('../start.sh',import.meta.url)),join(dir,'start.sh'));
      writeFileSync(join(dir,'.env'),'CHORDV_AGENT_ID=fixture-agent\nCHORDV_NODE_ID=fixture-node\nCHORDV_AGENT_TOKEN=fixture-only\nCHORDV_LOCAL_XRAY_BINARY=fixture-bin\nCHORDV_LOCAL_XRAY_CONFIG=fixture-config\nCHORDV_API_PORT=3127\n');
      writeFileSync(join(dir,'scripts/local-runtime-bootstrap.sh'),'select_node_runtime(){ :; }\nensure_pnpm_and_dependencies(){ :; }\ninstall_local_runtime_cleanup(){ :; }\nensure_prisma_client(){ :; }\nprepare_local_database(){ :; }\n');
      mkdirSync(join(dir,'bin'));
      writeFileSync(join(dir,'bin/corepack'),'#!/bin/sh\nexit 0\n');chmodSync(join(dir,'bin/corepack'),0o755);
      writeFileSync(join(dir,'bin/node'),'#!/bin/sh\nif [ "$1" = "-" ]; then cat >/dev/null; exit 0; fi\nexec '+JSON.stringify(process.execPath)+' --import '+JSON.stringify(join(dir,'setup.mjs'))+' "$@"\n');chmodSync(join(dir,'bin/node'),0o755);
      const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('CHORDV_'))delete env[key];
      return spawnSync('bash',[join(dir,'start.sh'),'--with-agent','5188'],{encoding:'utf8',timeout:5000,env:{...env,PATH:join(dir,'bin')+':'+process.env.PATH,TEST_SCENARIO:mode}});
    }
    return spawnSync(process.execPath,['--import',join(dir,'setup.mjs'),join(dir,'scripts/local-backend-dev.mjs')],{
      encoding:'utf8',timeout:5000,env:{...process.env,CHORDV_ADMIN_PORT:'5188',TEST_SCENARIO:mode}
    });
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('only launches API/admin and probes through the selected same-origin address',()=>{
  const result=run('ready');assert.equal(result.status,0,result.stderr);
  const {input,options}=JSON.parse(result.stdout.split('\n')[0]);
  assert.deepEqual(input.map(x=>x.name),['api','admin']);
  assert.match(input[0].command,/dev:prepared/);assert.match(input[1].command,/--port 5188/);
  assert.equal(options.killTimeout,undefined);assert.deepEqual(options.killOthersOn,["success","failure"]);assert.match(result.stdout,/probe:http:\/\/127.0.0.1:5188\/api\/health\/ready/);
  assert.match(result.stdout,/后台服务已就绪/);
});
test('child failure never announces readiness',()=>{const result=run('child-failed');assert.equal(result.status,1);assert.doesNotMatch(result.stdout,/后台服务已就绪/);});
test('readiness deadline terminates its child processes and exits unsuccessfully',()=>{
  const result=run('timeout');assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/90 秒内未就绪/);assert.match(result.stdout,/stop:SIGTERM/);
});

test('explicit Agent entry loads root .env before launching every child',()=>{
  const result=run('agent');assert.equal(result.status,0,result.stderr);
  const record=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('{')));
  assert.deepEqual(record.input.map(item=>item.name),['api','admin','node-agent']);
  assert.equal(record.agentId,'fixture-agent');assert.equal(record.api,'http://127.0.0.1:3127');
});

test('real concurrently 9.2.1 terminates the live sibling when API exits',()=>{const result=run('real-child');assert.equal(result.error,undefined,result.stdout+"\n"+result.stderr);assert.equal(result.status,1,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/SIGTERM/);});
