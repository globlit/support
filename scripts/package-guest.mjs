import {mkdir,cp,writeFile,readFile} from 'node:fs/promises';
const out=new URL('../guest-dist/app/',import.meta.url);await mkdir(out,{recursive:true});
// The server's external runtime imports are zod and jose; Node supplies SQLite.
for(const name of ['zod','jose'])await cp(new URL('../node_modules/'+name,import.meta.url),new URL('node_modules/'+name,out),{recursive:true});
await writeFile(new URL('package.json',out),JSON.stringify({name:'support-managed-guest',private:true,type:'module',engines:{node:'>=24.5.0'}},null,2));
await writeFile(new URL('../README.txt',out),'Managed Linux guest application. Use deployment/managed/Dockerfile and assemble-image.sh to create a matching-architecture boot bundle. No host folders or runtime credentials are included.\n');
console.log('Packaged guest application and its existing runtime dependencies.');
