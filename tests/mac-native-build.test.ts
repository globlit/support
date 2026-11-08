import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('actual native sources typecheck with the selected macOS toolchain', {skip:process.platform!=='darwin'?'Requires macOS SwiftUI/AppKit SDK; Linux tests do not verify native compilation.':false},()=>{
 execFileSync('bash',['companion/macos/build-app.sh','--check'],{timeout:180000,stdio:'pipe'});
});

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'support native build ')),bin=join(root,'bin'),temp=join(root,'temporary'),log=join(root,'compiler.jsonl'),sdk=join(root,'SDK with spaces');
 await mkdir(bin);await mkdir(temp);await mkdir(sdk);
 const tool=async(name:string,body:string)=>writeFile(join(bin,name),'#!'+process.execPath+'\n'+body,{mode:0o700});
 await tool('uname',`process.stdout.write(process.argv[2]==='-s'?'Darwin\\n':'arm64\\n');`);
 await tool('xcrun',`const args=process.argv.slice(2);if(args.join(' ')==='--sdk macosx --find swiftc')process.stdout.write(process.env.TEST_COMPILER+'\\n');else if(args.join(' ')==='--sdk macosx --show-sdk-path')process.stdout.write(process.env.TEST_SDK+'\\n');else process.exit(90);`);
 await tool('swiftc',`const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_COMPILER_LOG,JSON.stringify(args)+'\\n');if(args.includes('-typecheck')&&process.env.TEST_COMPILER_FAIL==='1'){process.stderr.write('fixture: native typecheck failed\\n');process.exit(42);}`);
 const env={...process.env,PATH:bin+':'+process.env.PATH,TMPDIR:temp,TEST_COMPILER:join(bin,'swiftc'),TEST_SDK:sdk,TEST_COMPILER_LOG:log};
 return {root,temp,sdk,env,async calls():Promise<string[][]>{return (await readFile(log,'utf8')).trim().split('\n').map(s=>JSON.parse(s));},async done(){await rm(root,{recursive:true,force:true});}};
}

test('native preflight checks both real source entrypoints with consistent SDK/target and creates no app',async()=>{
 const f=await fixture();try{
  const result=spawnSync('bash',[resolve('companion/macos/build-app.sh'),'--check'],{cwd:f.root,env:f.env,encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);
  const calls=await f.calls();assert.equal(calls.length,3);assert.deepEqual(calls[0],['--version']);
  for(const args of calls.slice(1)){
   assert.equal(args[args.indexOf('-sdk')+1],f.sdk);
   assert.equal(args[args.indexOf('-target')+1],'arm64-apple-macosx13.0');
   assert.equal(args[args.indexOf('-swift-version')+1],'5');
   assert.ok(args.includes('-typecheck'));assert.ok(!args.includes('-o'));
  }
  assert.ok(calls[1].includes(resolve('companion/macos/SupportCompanion.swift')));
  assert.ok(calls[1].includes(resolve('companion/macos/ExistingVM.swift')));
  assert.ok(calls[1].includes('-parse-as-library'));
  assert.ok(calls[2].includes(resolve('companion/macos/InspectProcesses.swift')));
  assert.ok(!calls[2].includes('-parse-as-library'));
  assert.deepEqual(await readdir(f.temp),[]);assert.ok(!(await readdir(f.root)).includes('--check'));
 }finally{await f.done();}
});

test('DMG build aborts on native compiler errors before downloads and preserves an existing installer',async()=>{
 const f=await fixture();try{
  const repo=join(f.root,'checkout with spaces');await mkdir(join(repo,'scripts','macos'),{recursive:true});await mkdir(join(repo,'companion','macos'),{recursive:true});await mkdir(join(repo,'release'));
  await cp('scripts/macos/build-dmg.sh',join(repo,'scripts','macos','build-dmg.sh'));
  for(const name of ['build-app.sh','SupportCompanion.swift','ExistingVM.swift','InspectProcesses.swift'])await cp(join('companion','macos',name),join(repo,'companion','macos',name));
  const image=join(repo,'release','Support-arm64.dmg');await writeFile(image,'previous verified installer');
  const result=spawnSync('bash',[join(repo,'scripts','macos','build-dmg.sh')],{env:{...f.env,TEST_COMPILER_FAIL:'1'},encoding:'utf8',timeout:15000});
  assert.equal(result.status,42);assert.match(result.stderr,/native typecheck failed/);
  assert.match(result.stdout,/STEP 1 Checking native compilation/);assert.doesNotMatch(result.stdout,/STEP [23456]/);
  assert.equal((await f.calls()).length,2);assert.deepEqual(await readdir(join(repo,'.mac-build','cache')),[]);
  assert.deepEqual(await readdir(join(repo,'.mac-build')),['cache']);assert.deepEqual(await readdir(f.temp),[]);
  assert.equal(await readFile(image,'utf8'),'previous verified installer');
 }finally{await f.done();}
});
