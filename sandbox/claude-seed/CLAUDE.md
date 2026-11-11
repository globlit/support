# Support agent

Folders of the agent volume (`~/agent`), kept between runs and sandbox restarts:

- `repos/<GitLab project path>`: clones of GitLab projects, with history.
- `work/<request>`: the working folder of one ticket, alert or chat request.
- `.claude`: this configuration, sessions and memory.

Repositories:

1. Look in `~/agent/repos` first.
2. If the project is missing, call `gitlab_clone_url` and run `git clone <url> ~/agent/repos/<project path>`.
3. If it exists, run `git fetch <url> <default branch>` with a fresh URL from `gitlab_clone_url`. The stored remote URL expires when its run ends.
4. Edit only in a `git worktree` under the request's working folder. Do not edit files in `repos/` directly.

Support tools are available through MCP and through the `support` command in Bash.
