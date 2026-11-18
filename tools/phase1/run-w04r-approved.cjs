'use strict';
// Only the four frozen scripts explicitly approved for the single native UAC request.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');const {pathToFileURL}=require('node:url');
const root=process.argv[2], manifest=JSON.parse(fs.readFileSync(path.join(root,'uac-manifest.json'),'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(fs.realpathSync.native(root),path.resolve(root));assert.equal(manifest.root,root);
const approved=['tools/test-secure-files.js','tools/test-files-http.js','tools/test-secure-files-folder-fallback.js','tools/test-files-folder-fallback-http.js'];
assert.deepEqual(manifest.scripts,approved);assert.equal(process.execPath,manifest.node);
const verify=()=>{for(const row of manifest.files)assert.equal(hash(row.path),row.sha256,`frozen source changed: ${row.path}`);};
verify();
const token=spawnSync(path.join(process.env.SystemRoot,'System32/whoami.exe'),['/all'],{encoding:'utf8',windowsHide:true});
fs.writeFileSync(path.join(root,'uac-token.txt'),token.stdout);
assert.equal(token.status,0);assert(token.stdout.includes('S-1-16-12288'),'actual elevated high-integrity token required');
const record={startedAt:new Date().toISOString(),scope:'single UAC; exactly four approved file scripts; no other test/GUI/worker',rows:[]};
const save=()=>fs.writeFileSync(path.join(root,'w04r-results.json'),JSON.stringify(record,null,2)+'\n');
(async()=>{
 save();
 for(const script of approved){
  verify();
  const own=fs.mkdtempSync(path.join(root,'w04r-atomic-'));
  const env={};for(const key of ['SystemRoot','WINDIR','ComSpec','PATH','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',TEMP:own,TMP:own,TMPDIR:own,USERPROFILE:own,APPDATA:own,LOCALAPPDATA:own,
   DB_PATH:path.join(own,'baseline.db'),ANJIAN_FILES_ROOT:path.join(own,'files'),ANJIAN_AGENT_SESSION_ROOT:path.join(own,'sessions'),
   R2_RESOURCE_RESULTS:path.join(own,'resources.jsonl'),R2_NETWORK_RESULTS:path.join(own,'network.jsonl'),R2_CLEANUP_ARCHIVE:path.join(own,'cleanup-archive'),
   NODE_OPTIONS:`--import=${pathToFileURL(path.join(manifest.repository,'tools/phase1/r2-loopback-only.js')).href}`});
  fs.mkdirSync(env.ANJIAN_FILES_ROOT);fs.mkdirSync(env.ANJIAN_AGENT_SESSION_ROOT);
  const fd=fs.openSync(path.join(own,'output.log'),'wx');
  const row={script,sourceSha256:hash(path.join(manifest.repository,script)),evidence:own,startedAt:new Date().toISOString()};record.rows.push(row);save();
  const child=spawn(process.execPath,[path.join(manifest.repository,script)],{cwd:manifest.repository,env,windowsHide:true,stdio:['ignore',fd,fd]});
  let timer;let timedOut=false;
  const exit=await new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});},90000);child.on('error',e=>row.spawnError=String(e));child.on('close',(code,signal)=>resolve({code,signal}));});
  clearTimeout(timer);fs.closeSync(fd);Object.assign(row,{finishedAt:new Date().toISOString(),actualExitCode:exit.code,signal:exit.signal,timedOut});
  row.resources=fs.existsSync(env.R2_RESOURCE_RESULTS)?fs.readFileSync(env.R2_RESOURCE_RESULTS,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  row.status=exit.code===0&&!timedOut&&!row.spawnError&&row.resources.length&&row.resources.every(r=>r.main.status==='passed'&&r.cleanup.status==='passed')?'passed':'failed';save();
  if(row.status!=='passed'){record.stoppedAfterFailure=true;break;}
 }
 record.finishedAt=new Date().toISOString();record.status=record.rows.length===4&&record.rows.every(r=>r.status==='passed')?'passed':'partial';save();process.exitCode=record.status==='passed'?0:1;
})().catch(error=>{record.error=String(error);record.status='failed';save();process.exitCode=1;});
