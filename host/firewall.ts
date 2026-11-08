import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {renderPF,type NetworkPolicy} from './policy.js';
const exec=promisify(execFile);
// Fixed binaries and arguments only.
async function pf(args:string[]){return (await exec(process.getuid?.()===0?'/sbin/pfctl':'/usr/bin/sudo',process.getuid?.()===0?args:['-n','/sbin/pfctl',...args],{timeout:4000,maxBuffer:128*1024,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'}})).stdout;}
export function normalizedRules(text:string){return text.split('\n').map(s=>s.trim()).filter(s=>/^(block |pass |anchor )/.test(s)).map(s=>s.replace(/\s+/g,' ')).join('\n');}
export function checkLoadedPF({info,main,loaded,expected,interfaces,pfInterfaces}:{info:string;main:string;loaded:string;expected:string;interfaces:string;pfInterfaces?:string},policy:NetworkPolicy){
 if(!/^Status: Enabled\b/m.test(info))throw Error('Host packet filter is disabled.');
 const first=normalizedRules(main).split('\n')[0];
 if(!/^anchor "support_vm"(?: quick all| all quick| quick)$/.test(first??''))throw Error('support_vm must be the first, quick filter anchor.');
 if(!normalizedRules(expected)||normalizedRules(loaded)!==normalizedRules(expected))throw Error('Loaded host rules differ from the reviewed policy.');
 if(pfInterfaces&&/skip/i.test(pfInterfaces))throw Error('PF skip interfaces require administrator review; isolation cannot be verified.');
 if(!new RegExp('^'+policy.interface+':','m').test(interfaces))throw Error('Dedicated VM interface is missing.');
}
/** Audit only. Never changes PF rules. */
export async function verifyPF(policy:NetworkPolicy){
 if(process.platform!=='darwin')throw Error('VM host enforcement requires macOS. This Linux service is unchanged.');
 const file='/etc/pf.anchors/support_vm';
 const stat=await lstat(file);if(!stat.isFile()||stat.uid!==0||stat.mode&0o022||await realpath(file)!==file)throw Error('Host policy must be a root-owned, non-writable regular file.');
 if((await readFile(file,'utf8')).trim()!==renderPF(policy).trim())throw Error('Installed policy differs from the host profile.');
 const info=await pf(['-s','info']),main=await pf(['-sr']),loaded=await pf(['-a','support_vm','-sr']),expected=await pf(['-nvf',file]),pfInterfaces=await pf(['-v','-s','Interfaces']);
 const interfaces=(await exec('/sbin/ifconfig',['-a'],{timeout:4000,maxBuffer:128*1024,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'}})).stdout;
 checkLoadedPF({info,main,loaded,expected,interfaces,pfInterfaces},policy);
}
