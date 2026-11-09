import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateToolboxSetup,isExcluded,setupHash,toolboxConfigJson} from '../server/toolbox-setup.js';
import {configSchema,defaults,toolboxDefaults} from '../src/model.js';

test('namespace patterns match exact names and * wildcards only',()=>{
 const patterns=['kube-*','*gitlab*','monitoring'];
 for(const ns of ['kube-system','kube-public','gitlab','my-gitlab-runner','monitoring'])assert.equal(isExcluded(ns,patterns),true,ns);
 for(const ns of ['apps','monitoring-2','kubex','default'])assert.equal(isExcluded(ns,patterns),false,ns);
 assert.equal(isExcluded('a.b',['a.b']),true);assert.equal(isExcluded('axb',['a.b']),false);
});

test('the configuration carries the behaviour settings for every context',()=>{
 const settings={...toolboxDefaults,allowConfigMaps:true,allowPortForward:true,timeoutSeconds:45,maxOutputMiB:2,portForwardMaxSeconds:120,redactionLiterals:['internal.example.com'],redactionPatterns:['tok-[a-z]+']};
 const config=JSON.parse(toolboxConfigJson(settings,[{name:'dev',namespaces:['apps','default']},{name:'prod',namespaces:['web']}],'/usr/local/bin/kubectl'));
 assert.equal(config.kubectl.kubeconfig,'{{kubeconfig}}');
 assert.deepEqual(config.kubectl.contexts[0],{name:'dev',default_namespace:'default',namespaces:['apps','default'],allow_cluster_scoped:false,allow_port_forward:true,disable_configmaps:false});
 assert.equal(config.kubectl.contexts[1].default_namespace,'web');
 assert.deepEqual([config.kubectl.timeout_seconds,config.kubectl.max_output_bytes,config.kubectl.port_forward_max_seconds],[45,2*1024*1024,120]);
 assert.deepEqual(config.redaction,{literals:['internal.example.com'],patterns:['tok-[a-z]+']});
});

test('the out-of-date check follows the settings and the selected contexts',()=>{
 const hash=setupHash(toolboxDefaults,['b','a']);
 assert.equal(setupHash(toolboxDefaults,['a','b']),hash);
 assert.notEqual(setupHash({...toolboxDefaults,allowConfigMaps:true},['a','b']),hash);
 assert.notEqual(setupHash(toolboxDefaults,['a']),hash);
});

test('the former comma-separated excluded namespaces move into the Toolbox settings',()=>{
 const {toolbox:_t,...rest}=structuredClone(defaults);
 const parsed=configSchema.parse({...rest,excludedNamespaces:'kube-*, *gitlab*,,team-x'});
 assert.deepEqual(parsed.toolbox.excludedNamespaces,['kube-*','*gitlab*','team-x']);assert.equal(parsed.toolbox.allowConfigMaps,false);
 assert.equal('excludedNamespaces' in parsed,false);
});

test('generation lists namespaces per context, removes excluded ones and validates with Toolbox',{skip:process.platform!=='linux'},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'support-toolbox-setup-test-')),kubectl=join(dir,'kubectl'),toolbox=join(dir,'toolbox'),previous=[process.env.SUPPORT_KUBECTL_BINARY,process.env.SUPPORT_TOOLBOX_BINARY];
 writeFileSync(kubectl,`#!/bin/sh
case "$*" in
 *"get-contexts"*) printf 'dev\nprod\nbig\nempty\nbroken\n';;
 *"--context dev "*) printf 'default kube-system apps gitlab-runner';;
 *"--context prod "*) printf 'web';;
 *"--context big "*) i=0; while [ $i -lt 101 ]; do printf "ns-$i "; i=$((i+1)); done;;
 *"--context empty "*) printf 'kube-system kube-public';;
 *) echo 'Unable to connect to the server: dial tcp: no such host' >&2; exit 1;;
esac
`,{mode:0o700});
 writeFileSync(toolbox,`#!/bin/sh
config=$2
if grep -q 'reject-me' "$config"; then echo 'invalid redaction regular expression' >&2; exit 2; fi
echo '{"contexts":[]}'
`,{mode:0o700});
 process.env.SUPPORT_KUBECTL_BINARY=kubectl;process.env.SUPPORT_TOOLBOX_BINARY=toolbox;
 const kubeconfig='apiVersion: v1\nkind: Config\n';
 try{
  const setup=await generateToolboxSetup(kubeconfig,['dev','prod'],toolboxDefaults);
  assert.deepEqual(setup.contexts,[{name:'dev',namespaces:['apps','default'],excluded:2},{name:'prod',namespaces:['web'],excluded:0}]);
  const config=JSON.parse(setup.config);assert.deepEqual(config.kubectl.contexts.map((c:{namespaces:string[]})=>c.namespaces),[['apps','default'],['web']]);assert.equal(config.kubectl.binary,kubectl);
  await assert.rejects(generateToolboxSetup(kubeconfig,['missing'],toolboxDefaults),/no context named missing/);
  await assert.rejects(generateToolboxSetup(kubeconfig,['big'],toolboxDefaults),/101 allowed namespaces/);
  await assert.rejects(generateToolboxSetup(kubeconfig,['empty'],toolboxDefaults),/Every namespace of context empty is excluded/);
  await assert.rejects(generateToolboxSetup(kubeconfig,['broken'],toolboxDefaults),/Namespaces of context broken could not be listed: Unable to connect to the server/);
  await assert.rejects(generateToolboxSetup(kubeconfig,['prod'],{...toolboxDefaults,redactionPatterns:['reject-me']}),/Toolbox rejected the generated configuration: invalid redaction regular expression/);
  await assert.rejects(generateToolboxSetup(kubeconfig,[],toolboxDefaults),/Select at least one context/);
 }finally{
  if(previous[0]===undefined)delete process.env.SUPPORT_KUBECTL_BINARY;else process.env.SUPPORT_KUBECTL_BINARY=previous[0];
  if(previous[1]===undefined)delete process.env.SUPPORT_TOOLBOX_BINARY;else process.env.SUPPORT_TOOLBOX_BINARY=previous[1];
  rmSync(dir,{recursive:true,force:true});
 }
});
