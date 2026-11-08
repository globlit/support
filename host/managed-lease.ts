/** Host-only stdin lease. Invalid, expired or closed control streams cannot recover. */
export function managedLease(onClose:()=>void, clock=Date.now) {
 let pending='', last=clock(), closed=false, running=false;
 const close=()=>{if(closed)return;closed=true;running=false;onClose();};
 return {
  get running(){return running&&!closed;},
  tick(){if(clock()-last>6000)close();},
  close,
  write(chunk:string){
   if(closed)return;
   if(clock()-last>6000||pending.length+chunk.length>1024){close();return;}
   pending+=chunk;
   let index:number;
   while(!closed&&(index=pending.indexOf('\n'))>=0){
    const line=pending.slice(0,index);pending=pending.slice(index+1);
    if(line!=='RUNNING'&&line!=='BOOTING'){close();return;}
    running=line==='RUNNING';last=clock();
   }
  },
 };
}
