import test from 'node:test';
import assert from 'node:assert/strict';
import {shellProgram,toolLabel,countTools} from '../src/tool-usage.js';

test('a shell command counts as its first program',()=>{
 const cases:[string,string][]=[
  ['ls | grep -e "toto"','ls'],['ls -lart | grep "haha"','ls'],['cd repo && git log --oneline','git'],['cd /tmp; set -e; curl -s https://x | jq .','curl'],
  ['FOO=1 BAR=2 python3 check.py','python3'],['sudo -u admin kubectl get pods','kubectl'],['timeout 30 curl -s x','curl'],['env -i PATH=/bin rg netpol','rg'],
  ["bash -c 'yq .spec file.yaml | head'",'yq'],['bash -lc "helm template . | kubeconform"','helm'],['/usr/local/bin/kubectl get ns','kubectl'],['echo "a | b; c" && ls','echo'],
  ['git log || true','git'],['( cd x && make )','make'],['','shell'],['cd /tmp','shell'],
 ];
 for(const [command,expected] of cases)assert.equal(shellProgram(command),expected,command);
});

test('Support tools count under their integration, Claude Code tools by name, notes not at all',()=>{
 assert.equal(toolLabel('Bash',JSON.stringify({command:'rg netpol ~/claude_access/gitlab'})),'rg');
 assert.equal(toolLabel('run_command',JSON.stringify({command:'ls'})),'ls');
 assert.equal(toolLabel('kubernetes_read'),'kubernetes');assert.equal(toolLabel('kubectl'),'kubernetes');assert.equal(toolLabel('mcp__support__outline_search'),'outline');
 assert.equal(toolLabel('prometheus_query_range'),'prometheus');assert.equal(toolLabel('gitlab_file'),'gitlab');assert.equal(toolLabel('WebFetch'),'WebFetch');
 assert.equal(toolLabel('submit_result'),'submit_result');assert.equal(toolLabel('note'),undefined);assert.equal(toolLabel('Bash','not json'),'shell');
});

test('counts are sorted and keep failures',()=>{
 const c=countTools([{tool:'Bash',input:'{"command":"ls"}',status:'complete'},{tool:'Bash',input:'{"command":"ls -l | wc"}',status:'failed'},{tool:'kubernetes_read',status:'complete'},{tool:'note'},{text:'x'} as {tool?:string}]);
 assert.deepEqual(c,[{label:'ls',total:2,failed:1},{label:'kubernetes',total:1,failed:0}]);
});

test('a step preview shows what ran on one line',async()=>{
 const {stepPreview}=await import('../src/tool-usage.js');
 assert.equal(stepPreview('Bash',JSON.stringify({command:'kubectl get netpol -n app\necho done'})),'$ kubectl get netpol -n app');
 assert.equal(stepPreview('note','',`\nThe policy blocks ingress.\nMore.`),'The policy blocks ingress.');
 assert.equal(stepPreview('Read',JSON.stringify({file_path:'/x/values.yaml'})),'/x/values.yaml');
 assert.equal(stepPreview('Grep',JSON.stringify({pattern:'netpol',path:'gitlab'})),'netpol in gitlab');
 assert.equal(stepPreview('mcp__support__kubernetes_read',JSON.stringify({context:'dev',resource:'pods',namespace:'app'})),'dev · pods · app');
 assert.equal(stepPreview('outline_search',JSON.stringify({query:'netpol.sahar.fr'})),'netpol.sahar.fr');
 assert.equal(stepPreview('x','not json'),'not json');
 const long=stepPreview('Bash',JSON.stringify({command:'echo '+'a'.repeat(400)}));assert.equal(long.length,160);assert.ok(long.endsWith('…'));
});
