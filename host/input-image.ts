import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,mkdtemp,readdir,chmod,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {privatePath,snapshot} from './files.js';
const exec=promisify(execFile);
export async function inputImage(source:string,output:string,protectedPaths:string[]){
 if(process.platform!=='darwin')throw Error('Input disk creation requires macOS hdiutil. Use snapshot here to validate the inputs.');
 const destination=resolve(output);if(!destination.endsWith('.iso'))throw Error('Choose a new .iso file.');
 await privatePath(dirname(destination),true);if(await lstat(destination).catch(()=>null))throw Error('Input image already exists; it will not be replaced.');
 const stage=await mkdtemp(join(dirname(destination),'input-'));
 async function remove(p:string){await chmod(p,0o700);for(const e of await readdir(p,{withFileTypes:true}))if(e.isDirectory())await remove(join(p,e.name));await rm(p,{recursive:true,force:true});}
 try{
  const result=await snapshot(source,join(stage,'files'),{protectedPaths});
  await exec('/usr/bin/hdiutil',['makehybrid','-iso','-joliet','-o',destination,join(stage,'files')],{timeout:120000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
  await chmod(destination,0o400);return {...result,image:destination};
 }catch(e){await rm(destination,{force:true});throw e;}finally{await remove(stage);}
}
