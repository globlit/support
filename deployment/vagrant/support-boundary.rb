# Load from a HOST-OWNED Vagrantfile, outside all guest-visible files.
# Does not replace/guess the native Apple provider or configure its network.
# require_relative '/host/path/to/support-boundary'
# SupportBoundary.configure(config)
module SupportBoundary
  class Guard < Vagrant.plugin('2', :config)
    attr_accessor :repositories
    def validate(machine)
      errors = []
      enabled = machine.config.vm.synced_folders.values.reject { |folder| folder[:disabled] }
      errors << 'Support VM must have NO synced folders, including /vagrant and /workspace. Use a single explicitly approved Tart repositories volume instead.' unless enabled.empty?
      errors << 'SSH agent forwarding must be disabled.' if machine.config.ssh.forward_agent
      if machine.provider_name.to_s == 'tart'
        if repositories
          begin
            path = File.realpath(repositories)
            project = File.realpath(machine.env.root_path.to_s)
            home = File.realpath(Dir.home)
            protected = [home + '/Library', home + '/.ssh', home + '/.vagrant.d', '/Applications', '/System', '/Library']
            invalid = path != repositories || [home, '/', '/Users', '/Volumes'].include?(path) || path.split('/').any? { |p| p.start_with?('.') }
            invalid ||= project == path || project.start_with?(path + '/')
            invalid ||= protected.any? { |p| path == p || path.start_with?(p + '/') || p.start_with?(path + '/') }
            errors << 'Repository share overlaps host configuration or is not a narrow real folder.' if invalid
          rescue SystemCallError
            errors << 'The selected repository share does not exist on this Mac.'
          end
        end
        errors.concat(SupportBoundary.tart_errors(machine.provider_config, repositories))
      end
      machine.config.vm.networks.each do |kind, options|
        errors << 'Forwarded ports bypass the host gateway; remove this forwarding rule.' if kind == :forwarded_port && options[:disabled] != true
      end
      { 'Support host boundary' => errors }
    end
  end
  def self.approved_volume?(value, repositories)
    return false unless repositories
    match = value.match(/\A(?:[a-zA-Z0-9_.-]{1,64}:)?(\/[^:]+)(?::tag=[a-zA-Z0-9_.-]{1,64})?\z/)
    match && match[1] == repositories
  end
  # Returns error messages for Tart provider settings. Clipboard sharing and every network mode are accepted.
  def self.tart_errors(provider, repositories = nil)
    errors = []
    errors << 'Tart volumes must contain only the explicitly selected repositories folder.' unless provider.volumes.empty? || provider.volumes.length == 1 && approved_volume?(provider.volumes.first,
repositories)
    args = provider.extra_run_args
    forbidden = %w[--disk --rosetta --vnc --vnc-experimental]
    shares = provider.volumes.dup
    args.each_with_index do |arg, i|
      shares << args[i + 1] if arg == '--dir'
      shares << arg.delete_prefix('--dir=') if arg.start_with?('--dir=')
    end
    errors << 'Only one approved repository share is permitted.' unless shares.empty? || shares.length == 1 && shares.first && approved_volume?(shares.first, repositories)
    if args.any? { |arg| forbidden.any? { |flag| arg == flag || arg.start_with?(flag + '=') } }
      errors << 'Tart extra arguments contain a host disk, Rosetta share or remote-control bypass.'
    end
    errors << 'Tart VNC must be disabled.' if provider.vnc || provider.vnc_experimental
    errors
  end
  class Plugin < Vagrant.plugin('2')
    name 'Support host boundary'
    config(:support_boundary) { Guard }
  end
  def self.configure(config, repositories: nil)
    config.ssh.forward_agent = false
    config.vm.synced_folder '.', '/vagrant', disabled: true
    # Vagrant injects an SSH TCP forward by default. Use direct SSH to the reviewed
    # static guest address, not an implicit host-facing NAT port.
    config.vm.network :forwarded_port, guest: 22, host: 2222, id: 'ssh', disabled: true
    # Force validation of all folders in the final merged Vagrant configuration.
    config.support_boundary.repositories = repositories
  end
end
