import {readFile,mkdir,writeFile} from 'node:fs/promises';
// Small dependency-free ZIP writer (stored entries). Fixed allowlist, never workspace data.
const entries=['SupportCompanion.swift','ManagedFiles.swift','ManagedTransport.swift','ManagedVM.swift','ManagedVMView.swift','ManagedVM.entitlements','Info.plist','install.sh','README.md'];
function crc32(data){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
const local=[],central=[];let offset=0;
for(const filename of entries){
 const name=Buffer.from('Support Companion/'+filename),data=await readFile(new URL('../companion/macos/'+filename,import.meta.url)),crc=crc32(data);
 const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
 local.push(header,name,data);
 const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x21,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);central.push(record,name);
 offset+=header.length+name.length+data.length;
}
const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(Buffer.concat(central).length,12);end.writeUInt32LE(offset,16);
const out=new URL('../dist/downloads/',import.meta.url);await mkdir(out,{recursive:true});await writeFile(new URL('support-companion.zip',out),Buffer.concat([...local,...central,end]));
const guide=await readFile(new URL('../companion/macos/README.md',import.meta.url),'utf8');
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const inline=s=>escape(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
const markup=guide.split('\n\n').map(block=>{
 if(/^###? /.test(block)){const depth=block.startsWith('##')?2:1;return `<h${depth}>${inline(block.replace(/^#+ /,''))}</h${depth}>`;}
 if(/^\d+\. /.test(block))return '<ol>'+block.split('\n').map(line=>'<li>'+inline(line.replace(/^\d+\. /,''))+'</li>').join('')+'</ol>';
 if(block.startsWith('- '))return '<ul>'+block.split('\n').map(line=>'<li>'+inline(line.replace(/^- /,''))+'</li>').join('')+'</ul>';
 return '<p>'+inline(block)+'</p>';
}).join('\n');
await writeFile(new URL('companion-guide.html',out),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Support Companion · Setup</title><style>:root{color-scheme:light dark}body{font:15px/1.65 system-ui;margin:48px auto;padding:0 24px;max-width:850px}li{margin:10px 0}code{font-size:.9em;padding:2px 5px;background:#8882;border-radius:4px}h1,h2{line-height:1.2}h2{margin-top:32px}a{color:inherit}</style><a href="/#/settings?section=Notifications">← Return to Support</a><main>${markup}</main></html>`);
console.log('Packaged Mac companion source installer and setup guide.');
