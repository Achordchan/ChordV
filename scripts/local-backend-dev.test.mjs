import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
        console.log(JSON.stringify({input, options}));
        let resolve;
        const result = process.env.TEST_SCENARIO === 'child-failed' ? Promise.reject(new Error('child failed')) : new Promise(r => resolve=r);
        if(process.env.TEST_SCENARIO === 'ready') setTimeout(()=>resolve([]),40);
        return {result, commands:input.map(()=>({kill(signal){console.log('stop:'+signal);resolve?.([]);}}))};
      }
    `);
    writeFileSync(join(dir,'setup.mjs'), `
      globalThis.fetch = async (url) => {
        console.log('probe:'+url);
        return {ok:process.env.TEST_SCENARIO==='ready',headers:new Map([['content-type','text/html']]),body:{cancel:async()=>{}},json:async()=>({status:'ready'})};
      };
      if(process.env.TEST_SCENARIO==='timeout'){let now=0;Date.now=()=>now+=50000;}
    `);
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
  assert.equal(options.killTimeout,10000);assert.match(result.stdout,/probe:http:\/\/127.0.0.1:5188\/api\/health\/ready/);
  assert.match(result.stdout,/后台服务已就绪/);
});
test('child failure never announces readiness',()=>{const result=run('child-failed');assert.equal(result.status,1);assert.doesNotMatch(result.stdout,/后台服务已就绪/);});
test('readiness deadline terminates its child processes and exits unsuccessfully',()=>{
  const result=run('timeout');assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/90 秒内未就绪/);assert.match(result.stdout,/stop:SIGTERM/);
});
