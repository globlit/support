export type TartInstallation={provider:string;pluginVersion?:string;tartVersion?:string;softnetVersion?:string;tartHelp?:string;softnetHelp?:string};
/** Installation facts are diagnostics, never an attestation authorizing a tunnel. */
export function tartReadiness(input:TartInstallation){
 const checks=[
  {name:'Vagrant provider',ok:input.provider==='tart',detail:input.provider==='tart'?'Tart (Apple Virtualization.framework)':`Detected ${input.provider||'no running provider'}`},
  {name:'Vagrant plugin',ok:input.pluginVersion==='1.0.0',detail:input.pluginVersion?`vagrant-tart ${input.pluginVersion}`:'vagrant-tart was not found'},
  {name:'Tart',ok:!!input.tartVersion&&!!input.tartHelp?.includes('--net-softnet-block'),detail:input.tartVersion||'Tart is not installed or could not be inspected'},
  {name:'Host address rules',ok:!!input.softnetHelp?.includes('@host'),detail:input.softnetVersion||'Softnet is not installed or could not be inspected'},
  {name:'Directional SSH rules',ok:!!input.softnetHelp?.includes('in proto tcp'),detail:input.softnetHelp?.includes('in proto tcp')?'Stateful inbound rules advertised':'A host-only SSH flow must not allow guest-initiated Mac connections'},
 ];
 return {provider:'tart',ready:false,checks,message:'Installation check only. Before connecting, verify the running VM has no shared folders, clipboard, extra devices or network bypass, and test its host-side filtering. No SSH tunnel was opened.'};
}
