export type TartInstallation={provider:string;pluginVersion?:string;tartVersion?:string};
/** Diagnostics only. Does not authorize a tunnel. */
export function tartReadiness(input:TartInstallation){
 const checks=[
  {name:'Vagrant provider',ok:input.provider==='tart',detail:input.provider==='tart'?'Tart (Apple Virtualization.framework)':`Detected ${input.provider||'no running provider'}`},
  {name:'Vagrant plugin',ok:input.pluginVersion==='1.0.0',detail:input.pluginVersion?`vagrant-tart ${input.pluginVersion}`:'vagrant-tart was not found'},
  {name:'Tart',ok:!!input.tartVersion,detail:input.tartVersion||'Tart is not installed or could not be inspected'},
 ];
 return {provider:'tart',ready:false,checks,message:'Installation check only. Before connecting, verify the running VM has no unapproved shared folders or extra devices. Clipboard sharing is allowed. Support does not check or enforce the VM network. No SSH tunnel was opened.'};
}
