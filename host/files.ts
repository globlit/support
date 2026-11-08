import {constants} from 'node:fs';
import {lstat,realpath,open,mkdir,readdir,rm,chmod,writeFile} from 'node:fs/promises';
import {resolve,dirname,join,relative,parse} from 'node:path';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';

export async function privatePath(path:string, directory=false){
 const full=resolve(path);
 if(await realpath(full)!==full)throw Error('Host boundary files must not use symlinks.');
 const st=await lstat(full);
 if(st.uid!==process.getuid?.()||st.mode&0o077||!(directory?st.isDirectory():st.isFile()))throw Error('Host boundary files must be owned by this user and private (0700 directory / 0600 file).');
 return full;
}
const within=(root:string,child:string)=>child===root||(!relative(root,child).startsWith('..')&&!relative(root,child).startsWith('/'));
const excluded=new Set(['.git','.ssh','.aws','.kube','.support-data','.vagrant','node_modules','.DS_Store','.env','.netrc','.npmrc','.gitconfig']);
/** Export independent regular files; never mount the source or copy back guest outputs. */
export async function snapshot(source:string,destination:string,{protectedPaths=[],maxBytes=256*1024*1024,maxFiles=20000}:{protectedPaths?:string[];maxBytes?:number;maxFiles?:number}={}){
 const root=resolve(source),dest=resolve(destination);
 if(await realpath(root)!==root||!(await lstat(root)).isDirectory())throw Error('Select a real directory, not a symlink.');
 if([parse(root).root,homedir(),'/Users','/home','/etc','/var','/private','/Applications','/Library','/System','/Volumes'].includes(root)||root.split('/').some(s=>s.startsWith('.'))||protectedPaths.some(p=>within(root,resolve(p))||within(resolve(p),root)))throw Error('Select a narrow workspace folder outside host application, credentials and configuration.');
 if(within(root,dest)||within(dest,root))throw Error('Snapshot must be separate from its source.');
 await privatePath(dirname(dest),true);
 await mkdir(dest,{mode:0o700}); // Must not already exist; no overwrite or merge.
 let bytes=0,files=0;const manifest:{path:string;bytes:number;sha256:string}[]=[];
 try{
  async function walk(src:string,out:string,depth:number){
   if(depth>32)throw Error('Snapshot nesting limit exceeded.');
   if(await realpath(src)!==src)throw Error('Source directory changed or contains a symlink.');
   for(const name of await readdir(src)){
    if(excluded.has(name)||name.startsWith('.env.')||/[\x00-\x1f\x7f]/.test(name))continue;
    const input=join(src,name),output=join(out,name),st=await lstat(input);
    if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory())||st.isFile()&&st.nlink!==1)throw Error('Snapshot contains a symlink, hard link, socket or special file. Remove it from the selected input.');
    if(st.isDirectory()){await mkdir(output,{mode:0o700});await walk(input,output,depth+1);await chmod(output,0o500);continue;}
    if(++files>maxFiles||st.size>maxBytes-bytes)throw Error('Snapshot size limit exceeded.');
    const file=await open(input,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let data:Buffer;
    try{
     const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.dev!==st.dev||before.ino!==st.ino||before.size>maxBytes-bytes||await realpath(dirname(input))!==dirname(input))throw Error('Source changed during snapshot.');
     // Bounded read even if a file grows while being copied.
     data=Buffer.alloc(before.size);let offset=0;
     while(offset<data.length){const read=await file.read(data,offset,data.length-offset,offset);if(!read.bytesRead)throw Error('Source changed during snapshot.');offset+=read.bytesRead;}
     const after=await file.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Source changed during snapshot.');
    }finally{await file.close();}
    bytes+=data.length;await writeFile(output,data,{flag:'wx',mode:0o400});
    manifest.push({path:relative(dest,output),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
   }
  }
  await walk(root,dest,0);await writeFile(join(dest,'support-snapshot.json'),JSON.stringify({version:1,files:manifest},null,2),{flag:'wx',mode:0o400});await chmod(dest,0o500);return {files,bytes};
 }catch(e){
  async function writable(p:string){await chmod(p,0o700);for(const entry of await readdir(p,{withFileTypes:true}))if(entry.isDirectory())await writable(join(p,entry.name));}
  await writable(dest);await rm(dest,{recursive:true,force:true});throw e;
 }
}
