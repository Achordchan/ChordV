import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as api from '../src/api/client';
import * as recovery from '../src/lib/desktopSessionRecovery';
import * as lease from '../src/lib/sessionLeaseState';
import { ApiRequestError } from '../src/api/http';

const old = { accessToken: 'test-only-old-access', refreshToken: 'test-only-old-refresh', user: { id: 'old-account' } };
const fresh = { accessToken: 'test-only-new-access', refreshToken: 'test-only-new-refresh', user: { id: 'new-account' } };
const rotated = { ...old, accessToken: 'test-only-old-rotated-access', refreshToken: 'test-only-old-rotated-refresh' };
const bootstrap = (id: string) => ({ user: { id }, subscription: { state: 'active' }, policies: { defaultMode: 'rule' } });
const source = readFileSync(new URL('../src/hooks/useAuthBootstrap.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function barrier<T=void>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done,fail) => {resolve=done;reject=fail;}); return {promise,resolve,reject}; }

async function harness(input: { next?: typeof fresh; bootstrapGate?: ReturnType<typeof barrier<any>>; startupGate?: ReturnType<typeof barrier<any>>; refreshReplies?: Map<string,ReturnType<typeof barrier<any>>>; nativeRefresh?: (token:string)=>Promise<any>; saveGate?: ReturnType<typeof barrier<void>> } = {}) {
  const dir = await mkdtemp(join(tmpdir(),'chordv-auth-recovery-proof-'));
  const path = join(dir,'session.json');
  await writeFile(path,JSON.stringify(old),{mode:0o600});
  const refreshEntered=barrier(), newRefreshEntered=barrier(), refreshReply=barrier<any>(), bootstrapEntered=barrier(), startupEntered=barrier(), saveEntered=barrier();
  const trace: any[]=[];
  const state: any={session:old, bootstrap:bootstrap(old.user.id),generation:0,stops:0,writes:[],refreshTokens:[]};
  const server=createServer(async (req,res)=>{
    let data=''; for await (const chunk of req) data+=chunk;
    const token=JSON.parse(data).refreshToken;state.refreshTokens.push(token);
    trace.push({step:'http-refresh-enter',generation:state.generation}); refreshEntered.resolve();
    if(token===fresh.refreshToken)newRefreshEntered.resolve();
    const reply=await (input.refreshReplies?.get(token)??refreshReply).promise;
    res.writeHead(reply.status??200,{'content-type':'application/json'});
    res.end(JSON.stringify(reply.body??reply));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const saved=async(next:any)=>{
    trace.push({step:'save-enter',user:next.user.id,generation:state.generation});
    if(input.saveGate && next.accessToken===rotated.accessToken){saveEntered.resolve(); await input.saveGate.promise;}
    await writeFile(path,JSON.stringify(next),{mode:0o600}); state.writes.push(next.accessToken);
    trace.push({step:'save-commit',user:next.user.id,generation:state.generation});
  };
  const loaded=async()=>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}};
  const refreshed=async(token:string)=>{
    const response=await fetch(base+'/refresh',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:token})});
    const body=await response.json(); if(!response.ok)throw new ApiRequestError(response.status,'test-only refresh rejected'); return body;
  };
  const exports:any={};
  vm.runInNewContext(compiled,{exports,require:(id:string)=>{
    if(id==='react')return {useCallback:(fn:unknown)=>fn,useRef:(current:unknown)=>({current}),useEffect:()=>undefined};
    if(id==='../api/client')return api;
    if(id==='../lib/desktopSessionRecovery')return recovery;
    if(id==='../lib/sessionLeaseState')return lease;
    return {};
  }});
  const taskRef={current:null};
  const options=new Proxy({
    session:old,getCurrentSession:()=>state.session,nodes:[],authBusy:false,logoutBusy:false,refreshing:false,rememberPassword:false,modeLocked:false,
    credentials:{email:'test-only-new@invalid.example',password:'test-only-password'},unauthorizedRecoveryTaskRef:taskRef,
    login:async()=>input.next??fresh,logoutSession:async()=>{},
    fetchBootstrap:async(token:string)=>{
      if(input.startupGate && token===old.accessToken){startupEntered.resolve();return input.startupGate.promise;}
      if(input.bootstrapGate && token===rotated.accessToken){bootstrapEntered.resolve();return input.bootstrapGate.promise;}
      return bootstrap(token===(input.next??fresh).accessToken?(input.next??fresh).user.id:old.user.id);
    },fetchNodes:async()=>[],loadStoredSession:loaded,saveStoredSession:saved,
    refreshSession:refreshed,refreshStoredSessionNative:input.nativeRefresh??(async()=>{throw new Error('test-only controlled native refresh unavailable');}),
    clearStoredSession:async()=>{state.writes.push('clear');trace.push({step:'clear-store',generation:state.generation});await unlink(path).catch(()=>{});},
    forceStopLocalRuntime:async()=>{state.stops++;trace.push({step:'stop-runtime',generation:state.generation});},
    invalidateSessionOperations:()=>{state.generation++;},
    setSession:(next:any)=>{if(!next || state.session?.user.id!==next.user.id)state.generation++;state.session=next;trace.push({step:'set-session',user:next?.user.id??null,generation:state.generation});},
    setBootstrap:(next:any)=>state.bootstrap=next,resolveDefaultMode:()=> 'rule',pickNode:()=>null,runUpdateCheck:async()=>{},
  } as Record<string,any>,{get:(target,key:string)=>key in target?target[key]:()=>undefined});
  const hook=exports.useAuthBootstrap(options);
  const recover=(_session:any=old)=>hook.recoverSessionAfterUnauthorized();
  return {hook,recover,state,trace,loaded,applyNativeRotation:async(next:any)=>{await saved(next);options.setSession(next);},refreshEntered,newRefreshEntered,refreshReply,bootstrapEntered,startupEntered,saveEntered,taskRef,
    cleanup:async()=>{refreshReply.resolve(rotated); await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}};
}

test('delayed HTTP refresh must not overwrite new account',async t=>{
  const h=await harness();t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;
  await h.hook.handleLogout();await h.hook.handleLogin();assert.equal(h.state.session.user.id,fresh.user.id);
  h.refreshReply.resolve(rotated);const result=await running;
  assert.equal(h.state.session.user.id,fresh.user.id);assert.equal((await h.loaded()).user.id,fresh.user.id);
});

test('delayed old 401 must not clear or stop new account',async t=>{
  const h=await harness();t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;await h.hook.handleLogout();await h.hook.handleLogin();
  const stops=h.state.stops;h.refreshReply.resolve({status:401,body:{message:'test-only old refresh rejected'}});
  const result=await running;
  assert.equal(h.state.session?.user.id,fresh.user.id);assert.equal(h.state.stops,stops);
});

test('delayed old bootstrap must not replace new UI identity',async t=>{
  const gate=barrier<any>();const h=await harness({bootstrapGate:gate});t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;h.refreshReply.resolve(rotated);await h.bootstrapEntered.promise;
  await h.hook.handleLogout();await h.hook.handleLogin();gate.resolve(bootstrap(old.user.id));const result=await running;
  assert.equal(h.state.session.user.id,fresh.user.id);assert.equal(h.state.bootstrap.user.id,fresh.user.id);
});

test('old global save must not commit after newer queued login save',async t=>{
  const gate=barrier<void>();const h=await harness({saveGate:gate});t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;h.refreshReply.resolve(rotated);await h.saveEntered.promise;
  let logoutFinished=false;
  const loggingOut=h.hook.handleLogout().then(()=>{logoutFinished=true;});
  await new Promise<void>(done=>setImmediate(done));
  const finishedBeforeRelease=logoutFinished;
  gate.resolve();await loggingOut;await h.hook.handleLogin();await running;
  assert.equal(finishedBeforeRelease,false,'new logout/write must wait behind started old save');
  assert.deepEqual(h.state.writes,[rotated.accessToken,'clear',fresh.accessToken]);
  assert.equal((await h.loaded()).user.id,fresh.user.id);
});

test('logout and same-user relogin generation must invalidate old recovery',async t=>{
  const sameUser={...fresh,user:{id:old.user.id}};const h=await harness({next:sameUser});t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;
  await h.hook.handleLogout();await h.hook.handleLogin();assert.equal(h.state.session.accessToken,sameUser.accessToken);
  const generation=h.state.generation;h.refreshReply.resolve(rotated);const result=await running;
  assert.equal(h.state.session.accessToken,sameUser.accessToken);assert.equal(h.state.generation,generation);
});

test('new account scope runs independently and old finally cannot clear its task',async t=>{
  const oldReply=barrier<any>(),newReply=barrier<any>();
  const h=await harness({refreshReplies:new Map([[old.refreshToken,oldReply],[fresh.refreshToken,newReply]])});t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;await h.hook.handleLogout();await h.hook.handleLogin();
  const newRunning=h.recover();await h.newRefreshEntered.promise;const newTask=h.taskRef.current;
  oldReply.resolve(rotated);assert.equal(await running,null);
  assert.equal(h.taskRef.current,newTask,'old finally cleared new task');assert.notEqual(newTask,null);
  newReply.resolve(fresh);const result=await newRunning;
  assert.equal(result?.user.id,fresh.user.id);assert.equal(h.taskRef.current,null);
});

test('same-account current recovery still commits its rotation',async t=>{
  const h=await harness();t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;h.refreshReply.resolve(rotated);const result=await running;
  assert.equal(result?.accessToken,rotated.accessToken);assert.equal((await h.loaded()).accessToken,rotated.accessToken);
});

test('startup ownership fence preserves later logout and new login',async t=>{
  const gate=barrier<any>();const h=await harness({startupGate:gate});t.after(h.cleanup);
  const running=h.hook.restoreStoredSession();await h.startupEntered.promise;
  await h.hook.handleLogout();await h.hook.handleLogin();gate.resolve(bootstrap(old.user.id));const result=await running;
  assert.equal(result,null);assert.equal(h.state.session.user.id,fresh.user.id);assert.equal((await h.loaded()).user.id,fresh.user.id);
});

test('definitive current-account 401 clears only its current session',async t=>{
  const h=await harness();t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;h.refreshReply.resolve({status:401,body:{message:'test-only current refresh rejected'}});
  const result=await running;assert.equal(result,null);assert.equal(h.state.session,null);assert.equal(h.state.stops,1);assert.equal(await h.loaded(),null);
});


test('normal same-user Native self-rotation does not invalidate the owner',async t=>{
  const native={...rotated,accessToken:'test-only-native-access',refreshToken:'test-only-native-refresh'};
  const h=await harness({nativeRefresh:async()=>{await h.applyNativeRotation(native);return native;}});t.after(h.cleanup);
  const result=await h.recover();
  assert.equal(result?.accessToken,native.accessToken);assert.equal(h.state.generation,0);
  assert.equal((await h.loaded()).refreshToken,native.refreshToken);assert.deepEqual(h.state.refreshTokens,[]);
});

test('late Native failure cannot issue HTTP fallback for an obsolete owner',async t=>{
  const nativeEntered=barrier(),releaseNative=barrier();
  const h=await harness({nativeRefresh:async()=>{nativeEntered.resolve();await releaseNative.promise;throw new Error('test-only late Native rejection');}});t.after(h.cleanup);
  const running=h.recover();await nativeEntered.promise;await h.hook.handleLogout();await h.hook.handleLogin();
  releaseNative.resolve();assert.equal(await running,null);assert.deepEqual(h.state.refreshTokens,[]);
  assert.equal(h.state.session.user.id,fresh.user.id);assert.equal((await h.loaded()).user.id,fresh.user.id);
});

test('current HTTP503 keeps the original session as a temporary failure',async t=>{
  const h=await harness();t.after(h.cleanup);
  const running=h.recover();await h.refreshEntered.promise;h.refreshReply.resolve({status:503,body:{message:'test-only unavailable'}});
  const result=await running;assert.equal(result?.accessToken,old.accessToken);
  assert.equal((await h.loaded()).accessToken,old.accessToken);assert.equal(h.state.stops,0);assert.deepEqual(h.state.writes,[]);
});

test('same owner concurrent recovery shares one HTTP request',async t=>{
  const h=await harness();t.after(h.cleanup);
  const first=h.recover();await h.refreshEntered.promise;const second=h.recover();
  h.refreshReply.resolve(rotated);const results=await Promise.all([first,second]);
  assert.equal(results[0]?.accessToken,rotated.accessToken);assert.equal(results[1]?.accessToken,rotated.accessToken);
  assert.deepEqual(h.state.refreshTokens,[old.refreshToken]);assert.equal(h.taskRef.current,null);
});

test('manual refresh ownership cannot overwrite or stop a newer login',async t=>{
  const gate=barrier<any>();const h=await harness({startupGate:gate});t.after(h.cleanup);
  const refreshing=h.hook.handleRefresh();await h.startupEntered.promise;
  await h.hook.handleLogout();await h.hook.handleLogin();const stops=h.state.stops;
  gate.resolve(bootstrap(old.user.id));await refreshing;
  assert.equal(h.state.session.user.id,fresh.user.id);assert.equal((await h.loaded()).user.id,fresh.user.id);assert.equal(h.state.stops,stops);
});

test('manual refresh late rejection cannot clear or stop a newer login',async t=>{
  const gate=barrier<any>();const h=await harness({startupGate:gate});t.after(h.cleanup);
  const refreshing=h.hook.handleRefresh();await h.startupEntered.promise;
  await h.hook.handleLogout();await h.hook.handleLogin();const stops=h.state.stops;
  gate.reject(new ApiRequestError(401,'test-only old bootstrap rejected'));await refreshing;
  assert.equal(h.state.session.user.id,fresh.user.id);assert.equal((await h.loaded()).user.id,fresh.user.id);assert.equal(h.state.stops,stops);assert.deepEqual(h.state.refreshTokens,[]);
});

test('current manual refresh can recover its own token normally',async t=>{
  const gate=barrier<any>();const h=await harness({startupGate:gate});t.after(h.cleanup);
  const refreshing=h.hook.handleRefresh();await h.startupEntered.promise;
  gate.reject(new ApiRequestError(401,'test-only current bootstrap expired'));await h.refreshEntered.promise;
  h.refreshReply.resolve(rotated);await refreshing;
  assert.equal(h.state.session.accessToken,rotated.accessToken);assert.equal((await h.loaded()).accessToken,rotated.accessToken);assert.equal(h.state.stops,0);
});
