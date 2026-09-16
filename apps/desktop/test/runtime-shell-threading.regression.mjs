import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const source=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
function rustFunction(name) {
  const start=source.indexOf(`fn ${name}(`);assert.ok(start>=0,`missing ${name}`);
  const body=source.indexOf('{',start);let depth=1,end=body+1;
  for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
  return source.slice(start,end);
}
for(const name of ['runtime_status','runtime_logs','runtime_snapshot','clear_session','load_session','save_session','open_desktop_installer','open_external_url','test_routing_rule','consume_desktop_update_install_report','quit_for_update','install_windows_update','desktop_runtime_environment','get_runtime_component_local_info','check_runtime_component_file','ensure_bundled_runtime_components','download_runtime_component','download_desktop_installer','record_client_diagnostic']) {
  assert.match(source,new RegExp(`async fn ${name}\\(`),`${name} must not block the IPC main thread`);
  assert.match(rustFunction(name),/spawn_blocking/,`${name} must isolate mutex and filesystem waits`);
}
const shutdown=rustFunction('shutdown_runtime');
assert.match(shutdown,/let restore=clear_system_proxy\(\)/,'empty runtime state must still reconcile OS proxy ownership');
const startup=rustFunction('cleanup_stale_runtime');
assert.ok(startup.indexOf('clear_system_proxy()') < startup.indexOf('kill_pid('),'startup restores proxy before killing a stale listener');
const preflight=rustFunction('check_network_conflict');
assert.ok(preflight.indexOf('ensure_startup_ready')<preflight.indexOf('let check'),'startup barrier precedes the inspection timeout');
const android=readFileSync(new URL('../src-tauri/src/android_runtime.rs',import.meta.url),'utf8');
assert.match(android,/pub async fn start_android_runtime[\s\S]*?spawn_blocking/);
const androidWorker=android.slice(android.indexOf('fn start_android_runtime_blocking'));
assert.ok(androidWorker.indexOf('ensure_startup_ready')<androidWorker.indexOf('lock_current'),'Android must finish maintenance before locking and writing runtime files');
const refresh=rustFunction('refresh_shell_ui');
// Compile the actual dispatch function against a deterministic main-thread adapter.
// The UI reader must acquire RuntimeState before it services the queued menu work.
const harness=`
use std::sync::{mpsc,Arc,Mutex,atomic::{AtomicUsize,Ordering}};
use std::time::Duration;
#[derive(Clone)]
struct AppHandle { queue:mpsc::Sender<Box<dyn FnOnce()+Send>>, rendered:Arc<AtomicUsize>, main:std::thread::ThreadId }
impl AppHandle {
 fn run_on_main_thread<F:FnOnce()+Send+'static>(&self,f:F)->Result<(),String>{self.queue.send(Box::new(f)).map_err(|e|e.to_string())}
}
fn render_shell_ui(app:&AppHandle)->Result<(),String>{assert_eq!(std::thread::current().id(),app.main);app.rendered.fetch_add(1,Ordering::SeqCst);Ok(())}
fn append_download_diagnostic_log(_app:&AppHandle,_kind:&str,_message:String){panic!("unexpected rendering failure");}
${refresh}
fn main(){
 let (tx,rx)=mpsc::channel();let rendered=Arc::new(AtomicUsize::new(0));
 let app=AppHandle{queue:tx,rendered:Arc::clone(&rendered),main:std::thread::current().id()};
 let runtime=Arc::new(Mutex::new("starting"));let worker_runtime=Arc::clone(&runtime);
 let (locked_tx,locked_rx)=mpsc::channel();let (continue_tx,continue_rx)=mpsc::channel();
 let worker=std::thread::spawn(move||{
  let mut state=worker_runtime.lock().unwrap();locked_tx.send(()).unwrap();continue_rx.recv().unwrap();
  *state="connected";refresh_shell_ui(&app).unwrap();
 });
 locked_rx.recv_timeout(Duration::from_secs(5)).unwrap();continue_tx.send(()).unwrap();
 // Old code waits here forever: worker owns this mutex and waits for menu creation.
 assert_eq!(*runtime.lock().unwrap(),"connected");
 let render=rx.recv_timeout(Duration::from_secs(5)).unwrap();render();worker.join().unwrap();
 assert_eq!(rendered.load(Ordering::SeqCst),1);
}
`;
const root=mkdtempSync(path.join(tmpdir(),'chordv-shell-threading-'));
try {
 const rust=path.join(root,'check.rs'),binary=path.join(root,process.platform==='win32'?'check.exe':'check');writeFileSync(rust,harness);
 const rustc=process.env.RUSTC||path.join(homedir(),'.cargo','bin',process.platform==='win32'?'rustc.exe':'rustc');
 const build=spawnSync(rustc,['--edition=2021',rust,'-o',binary],{encoding:'utf8',timeout:30000});
 assert.equal(build.status,0,build.stderr||String(build.error));
 const result=spawnSync(binary,[],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr||String(result.error));
 console.log('actual shell dispatch releases runtime worker before main-thread rendering; blocking IPC reads isolated');
} finally {rmSync(root,{recursive:true,force:true});}
