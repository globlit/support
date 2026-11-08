import {readFile,writeFile,mkdir,readdir,cp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../host-dist/public/',import.meta.url);
await mkdir(new URL('../host-dist/',import.meta.url),{recursive:true});
await writeFile(new URL('../host-dist/package.json',import.meta.url),JSON.stringify({private:true,type:'module',engines:{node:'>=24.5.0'}},null,2));
await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
// Locally built trusted UI, not fetched from the guest at startup or on update.
for(const name of ['index.html','assets','downloads'])await cp(new URL('../dist/'+name,import.meta.url),new URL(name,root),{recursive:true});
const manifest={};
async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())throw Error('Host bundle cannot contain symlinks.');const name=prefix+entry.name,file=new URL(entry.name+(entry.isDirectory()?'/':''),dir);if(entry.isDirectory())await walk(file,name+'/');else manifest['/'+name]=createHash('sha256').update(await readFile(file)).digest('hex');}}
await walk(root);await writeFile(new URL('manifest.json',root),JSON.stringify(manifest,null,2));
console.log('Packaged independent host UI and data gateway (host-dist).');
