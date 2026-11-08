# Load from a HOST-OWNED Vagrantfile, outside all guest-visible files.
# Does not replace/guess the native Apple provider or configure its network.
# require_relative '/host/path/to/support-boundary'
# SupportBoundary.configure(config)
module SupportBoundary
  class Guard < Vagrant.plugin('2', :config)
    def validate(machine)
      errors = []
      enabled = machine.config.vm.synced_folders.values.reject { |folder| folder[:disabled] }
      errors << 'Support VM must have NO synced folders, including /vagrant and /workspace. Use an independent input disk or guest Git clone.' unless enabled.empty?
      errors << 'SSH agent forwarding must be disabled.' if machine.config.ssh.forward_agent
      if machine.provider_name.to_s == 'tart'
        errors.concat(SupportBoundary.tart_errors(machine.provider_config))
      end
      machine.config.vm.networks.each do |kind, options|
        errors << 'Support VM must not use public/bridged LAN networking.' if kind == :public_network
        errors << 'Forwarded ports bypass the host gateway; remove this forwarding rule.' if kind == :forwarded_port && options[:disabled] != true
      end
      { 'Support host boundary' => errors }
    end
  end
  def self.tart_errors(provider)
    errors = []
    errors << 'Tart clipboard sharing must be disabled.' if provider.clipboard
    errors << 'Tart provider volumes must be empty; read-only host shares are also forbidden.' unless provider.volumes.empty?
    args = provider.extra_run_args
    forbidden = %w[--dir --disk --rosetta --net-bridged --net-host --net-fd --net-softnet-expose --net-softnet-control-fd --vnc --vnc-experimental]
    if args.any? { |arg| forbidden.any? { |flag| arg == flag || arg.start_with?(flag + '=') } }
      errors << 'Tart extra arguments contain a host share, device, alternate network or remote-control bypass.'
    end
    errors << 'Tart VNC must be disabled.' if provider.vnc || provider.vnc_experimental
    errors
  end
  class Plugin < Vagrant.plugin('2')
    name 'Support host boundary'
    config(:support_boundary) { Guard }
  end
  def self.configure(config)
    config.ssh.forward_agent = false
    config.vm.synced_folder '.', '/vagrant', disabled: true
    # Vagrant injects an SSH TCP forward by default. Use direct SSH to the reviewed
    # static guest address, not an implicit host-facing NAT port.
    config.vm.network :forwarded_port, guest: 22, host: 2222, id: 'ssh', disabled: true
    # Force validation of all folders in the final merged Vagrant configuration.
    config.support_boundary
  end
end
