import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {tartReadiness} from '../host/tart-readiness.js';

test('Tart installation facts never authorize an unverified VM connection',()=>{
 const ready=tartReadiness({provider:'tart',pluginVersion:'1.0.0',tartVersion:'Tart installed',softnetVersion:'Softnet installed',tartHelp:'--net-softnet-block',softnetHelp:'@host in proto tcp'});
 assert.ok(ready.checks.every(c=>c.ok));assert.equal(ready.ready,false);assert.match(ready.message,/No SSH tunnel/);
 const missing=tartReadiness({provider:'tart',pluginVersion:'1.0.0'});
 assert.deepEqual(missing.checks.map(c=>c.ok),[true,true,false,false,false]);
 const other=tartReadiness({provider:'virtualbox',pluginVersion:'0.9'});assert.equal(other.checks[0].ok,false);assert.equal(other.checks[1].ok,false);
});

test('Mac builder uses the checked-in Node pins and no guest runtime downloads',async()=>{
 const pins=JSON.parse(await readFile('scripts/macos/assets.json','utf8'));
 const build=await readFile('scripts/macos/build-dmg.sh','utf8');
 assert.match(build,new RegExp('version='+pins.nodeVersion.replaceAll('.','\\.')));
 for(const hash of Object.values(pins.node))assert.ok(build.includes(hash as string));
 assert.equal(pins.ubuntu,undefined);assert.doesNotMatch(build,/cloud-images|first-boot|rootfs|vagrant up|tart run/);
 assert.match(build,/--proto '=https'/);assert.match(build,/Node checksum mismatch/);
 assert.match(build,/codesign --verify --deep --strict/);assert.match(build,/hdiutil verify/);
 assert.match(build,/ln -s \/Applications/);
 assert.match(build,/work="\$stage\/work"/);assert.match(build,/cd "\$work"/);
 assert.doesNotMatch(build,/ditto.*\.support-data|cp.*\.env|SUPPORT_DATA_DIR|rm.*Applications/);
});

test('Finder launcher and packaging scripts are syntactically valid without executing on Linux',()=>{
 for(const file of ['Build Support.app/Contents/MacOS/Build Support','scripts/macos/build-dmg.sh','companion/macos/build-app.sh','companion/macos/install.sh'])execFileSync('bash',['-n',file]);
});

test('Tart guard rejects explicit provider shares, clipboard and alternate host channels',t=>{
 const ruby=['/usr/bin/ruby','/opt/vagrant/embedded/bin/ruby'].find(p=>existsSync(p));
 if(!ruby){t.skip('Ruby/Vagrant runtime is not installed.');return;}
 const script=`
require 'ostruct'
module Vagrant
 class Stub
  def self.name(*); end
  def self.config(*); end
 end
 def self.plugin(*); Stub; end
end
load 'deployment/vagrant/support-boundary.rb'
def config(**changes)
 OpenStruct.new({clipboard:false,volumes:[],extra_run_args:[],vnc:false,vnc_experimental:false}.merge(changes))
end
raise unless SupportBoundary.tart_errors(config).empty?
raise if SupportBoundary.tart_errors(config(clipboard:true)).empty?
raise if SupportBoundary.tart_errors(config(volumes:['/Users/person:ro'])).empty?
raise if SupportBoundary.tart_errors(config(vnc:true)).empty?
%w[--dir=/Users/person --disk=/dev/disk0 --rosetta=host --net-fd=3 --net-bridged=en0 --net-host --net-softnet-expose=2222:22 --net-softnet-control-fd=3].each do |arg|
 raise arg if SupportBoundary.tart_errors(config(extra_run_args:[arg])).empty?
end
`;
 execFileSync(ruby,['-e',script],{stdio:'pipe'});
});
