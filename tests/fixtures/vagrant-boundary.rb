# Configuration-only fixture provider. It never creates or starts a VM.
require File.expand_path('../../deployment/vagrant/support-boundary', __dir__)
class SupportValidationProvider < Vagrant.plugin('2', :provider)
  def self.usable?(*args); true; end
  def state; Vagrant::MachineState.new(:not_created, 'not created', 'configuration test'); end
end
class SupportValidationPlugin < Vagrant.plugin('2')
  name 'support validation fixture'
  provider(:support_validation) { SupportValidationProvider }
end
Vagrant.configure('2') do |config|
  config.vm.box = 'support/fixture'
  case ENV['SUPPORT_CONFIG_TEST']
  when 'share' then config.vm.synced_folder '.', '/workspace'
  when 'port' then config.vm.network 'forwarded_port', guest: 4173, host: 4173
  when 'lan' then config.vm.network 'public_network'
  end
  SupportBoundary.configure(config)
  config.ssh.forward_agent = true if ENV['SUPPORT_CONFIG_TEST'] == 'agent'
end
