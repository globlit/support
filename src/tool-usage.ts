/** Programs that run another command given after their own options. The wrapped command is counted instead. */
const wrappers=new Set(['sudo','env','time','nice','nohup','timeout','xargs','command','exec','stdbuf','ionice','watch']);
/** Options of the wrappers that take a value in the next word, such as sudo -u USER. */
const valueOptions:Record<string,string[]>={sudo:['-u','-g','-C','-h','-p','-U'],env:['-u','-C','-S'],nice:['-n'],timeout:['-s','-k','--signal','--kill-after'],ionice:['-c','-n','-p'],xargs:['-I','-n','-P','-d','-L','-s','-E','-a'],stdbuf:['-i','-o','-e'],watch:['-n','-d']};
/** Support tool families: a tool name prefix and the label it is counted under. */
const families:[RegExp,string][]=[[/^(toolbox_|kubectl$)/,'toolbox'],[/^outline_/,'outline'],[/^prometheus_/,'prometheus'],[/^grafana_/,'grafana'],[/^gitlab_/,'gitlab'],[/^youtrack_/,'youtrack'],[/^alertmanager_/,'alertmanager']];

/** Splits a shell command into words, keeping quoted text together. Not a full shell parser. */
function words(text:string){
 const out:string[]=[];let cur='',quote='';
 for(const ch of text){
  if(quote){if(ch===quote)quote='';else cur+=ch;continue;}
  if(ch==='"'||ch==="'"){quote=ch;continue;}
  if(/\s/.test(ch)){if(cur){out.push(cur);cur='';}continue;}
  cur+=ch;
 }
 if(cur)out.push(cur);
 return out;
}
/** Splits a command line into its sequential commands (at ;, &&, || and newlines), outside quotes. */
function commands(text:string){
 const out:string[]=[];let cur='',quote='';
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(quote){cur+=ch;if(ch===quote)quote='';continue;}
  if(ch==='"'||ch==="'"){quote=ch;cur+=ch;continue;}
  if(ch===';'||ch==='\n'||(ch==='&'&&text[i+1]==='&')||(ch==='|'&&text[i+1]==='|')){out.push(cur);cur='';if(ch!==';'&&ch!=='\n')i++;continue;}
  cur+=ch;
 }
 out.push(cur);
 return out.map(c=>c.trim()).filter(Boolean);
}
/**
 * Returns the program a shell command line runs first: the first word of its first command, without variable
 * assignments, wrappers such as sudo or timeout, and leading cd or set steps. Pipes count as their first program:
 * "ls -l | grep x" gives "ls". For "bash -c '…'" the inner command is used. Returns "shell" when nothing is found.
 */
export function shellProgram(command:string,depth=0):string{
 for(const part of commands(command)){
  const head=part.split('|')[0];
  let w=words(head);
  while(w.length&&(/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])||w[0]==='('||w[0]==='{'))w=w.slice(1);
  while(w.length&&wrappers.has(w[0])){const valued=valueOptions[w[0]]??[];w=w.slice(1);while(w.length&&(w[0].startsWith('-')||/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])||/^\d+(\.\d+)?[smhd]?$/.test(w[0]))){const option=w[0];w=w.slice(valued.includes(option)?2:1);}}
  const program=(w[0]??'').replace(/^.*\//,'').replace(/^[({]+/,'');
  if(!program||program==='cd'||program==='set'||program==='export'||program==='source'||program==='.')continue;
  if((program==='bash'||program==='sh'||program==='zsh')&&w[1]==='-c'&&w[2]&&depth<2)return shellProgram(w[2],depth+1);
  if((program==='bash'||program==='sh'||program==='zsh')&&w[1]?.startsWith('-')&&w[1].includes('c')&&w[2]&&depth<2)return shellProgram(w[2],depth+1);
  return program;
 }
 return 'shell';
}
/**
 * Returns the label a tool call is counted under: the program for shell commands, the integration for Support tools
 * (toolbox, outline, prometheus…), or the tool name. Returns undefined for agent notes, which are not tool calls.
 */
export function toolLabel(tool:string,input?:string){
 if(!tool||tool==='note')return undefined;
 const name=tool.replace(/^mcp__support__/,'');
 if(name==='Bash'||name==='run_command'){let command='';try{command=String((JSON.parse(input??'{}') as {command?:unknown}).command??'');}catch{command='';}return command?shellProgram(command):'shell';}
 for(const [pattern,label] of families)if(pattern.test(name))return label;
 return name;
}
export type ToolCount={label:string;total:number;failed:number};
/** Counts tool calls by label, most used first. */
export function countTools(events:{tool?:string;input?:string;status?:string}[]):ToolCount[]{
 const counts=new Map<string,ToolCount>();
 for(const e of events){const label=e.tool?toolLabel(e.tool,e.input):undefined;if(!label)continue;const c=counts.get(label)??{label,total:0,failed:0};c.total++;if(e.status==='failed')c.failed++;counts.set(label,c);}
 return [...counts.values()].sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label));
}
/** Adds `more` into `into`, by label. */
export function mergeCounts(into:Map<string,ToolCount>,more:ToolCount[]){for(const c of more){const t=into.get(c.label)??{label:c.label,total:0,failed:0};t.total+=c.total;t.failed+=c.failed;into.set(c.label,t);}return into;}

const previewKeys=['context','resource','namespace','name','pod','selector','source','endpoint','query','project','path','ref','id','uid','question','outcome','title','target'];
/**
 * Returns a one-line summary of what a step ran, at most `max` characters: the command of a shell step, the first line
 * of an agent note, the file, pattern, URL or query of a Claude Code tool, or the main input values of a Support tool.
 */
export function stepPreview(tool:string,input?:string,result?:string,max=160){
 const cut=(v:string)=>{const line=v.replace(/\s+/g,' ').trim();return line.length>max?line.slice(0,max-1)+'…':line;};
 if(tool==='note')return cut((result??'').split('\n').find(l=>l.trim())??'');
 let v:Record<string,unknown>={};try{const parsed=JSON.parse(input??'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))v=parsed;else return cut(String(input??''));}catch{return cut(input??'');}
 const s=(k:string)=>typeof v[k]==='string'||typeof v[k]==='number'?String(v[k]):'';
 const name=tool.replace(/^mcp__support__/,'');
 if(name==='Bash'||name==='run_command')return cut('$ '+(s('command').split('\n')[0]??''));
 if(['Read','Write','Edit','MultiEdit','NotebookEdit'].includes(name))return cut(s('file_path')||s('notebook_path')||s('path'));
 if(name==='Grep'||name==='Glob')return cut([s('pattern'),s('path')].filter(Boolean).join(' in '));
 if(name==='WebFetch')return cut(s('url'));
 if(name==='WebSearch')return cut(s('query'));
 if(name==='Task'||name==='Agent')return cut(s('description')||s('prompt'));
 if(name==='TodoWrite'){const todos=Array.isArray(v.todos)?v.todos as {content?:string;status?:string}[]:[];return cut(`${todos.length} items${todos.find(t=>t.status==='in_progress')?.content?` · now: ${todos.find(t=>t.status==='in_progress')!.content}`:''}`);}
 const parts=previewKeys.map(s).filter(Boolean);
 if(Array.isArray(v.args))parts.push((v.args as unknown[]).join(' '));
 return cut(parts.length?parts.join(' · '):JSON.stringify(v));
}
