export function markdownText(value:string){return value.replace(/[\\`*_{}\[\]()<>#+.!|~-]/g, '\\$&').replace(/\r?\n/g,' ');}
export function markdownCode(value:string){const fence='`'.repeat(Math.max(1,...(value.match(/`+/g)??[]).map(s=>s.length+1)));return fence+' '+value.replace(/\r?\n/g,' ')+' '+fence;}
