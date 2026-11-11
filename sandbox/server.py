#!/usr/bin/env python3
# Command server of the Support sandbox. Runs the Support agent's commands and Claude Code sessions.
# Uses the Python standard library only.
#
# Environment:
#   SANDBOX_BIND          Address and port to listen on. Default: 0.0.0.0:7070.
#   SANDBOX_COMMAND_USER  User that runs commands and owns the run folders. When set, this server must run as
#                         another user with the setuid, setgid, setpcap and kill capabilities. Commands then
#                         cannot signal or replace this server. When unset, commands run as the server's user.
#   SANDBOX_RUNS_DIR      Folder of the run folders. Default: $HOME/runs.
#   SANDBOX_AGENT_ROOT    Folder under which agent sessions may run and change sets may be read. Agent endpoints
#                         are disabled when unset.
#
# Endpoints:
#   GET    /v1/health        {"ok":true,"running":N}
#   POST   /v1/exec          Body {"runId","command","timeoutSeconds"}. Streams {"type":"stdout"|"stderr","data"}
#                            lines, then {"type":"exit","code","signal","durationMs","truncated"}.
#   POST   /v1/kill-all      Kills every running command.
#   DELETE /v1/runs/:runId   Kills the run's commands and deletes its working folder.
#   PUT    /v1/runs/:runId/repos/:name          Body: a .tar.gz repository archive (at most 300 MB). Extracts it into
#                            runs/<runId>/repos/<name> without its top folder, then commits it as "base" in a new Git repository.
#   POST   /v1/agent        Body {"runId","cwd","args","env","timeoutSeconds","input"}. input is written to stdin first. Runs claude with args in cwd (under
#                            SANDBOX_AGENT_ROOT) and streams its output like /v1/exec, without the output limit.
#                            stdin stays open for /v1/agent/:runId/input.
#   POST   /v1/agent/:runId/input  Body {"data"}. Writes data to the running agent's stdin.
#   GET    /v1/changes?dir=&base=  Files changed in the Git folder dir (under SANDBOX_AGENT_ROOT or the run folders)
#                            since commit base, in the same format as the repos changes endpoint.
#   GET    /v1/runs/:runId/repos/:name/changes  Files changed since refs/support/base, or else since the root commit
#                            ("base"): {files:[{path,status,content}]}, content in
#                            base64, null for deleted files. At most 50 files and 2 MiB. Binary files and symlinks are refused.
import base64
import errno
import json
import math
import os
import queue
import re
import secrets
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

BIND = os.environ.get('SANDBOX_BIND', '0.0.0.0:7070')
HOST, PORT = re.split(r':(?=\d+$)', BIND)
RUNS_DIR = os.environ.get('SANDBOX_RUNS_DIR') or os.path.join(os.environ.get('HOME', '/home/admin'), 'runs')
AGENT_ROOT = os.environ.get('SANDBOX_AGENT_ROOT', '').strip()
COMMAND_USER = os.environ.get('SANDBOX_COMMAND_USER', '').strip()

if COMMAND_USER and not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', COMMAND_USER):
    sys.exit('SANDBOX_COMMAND_USER is not a valid user name.')

MAX_RUNNING = 8
MAX_OUTPUT = 1024 * 1024
MAX_TIMEOUT = 600
MAX_BODY = 64 * 1024
MAX_AGENT_BODY = 1024 * 1024
MAX_AGENT_TIMEOUT = 4 * 3600
MAX_AGENT_OUTPUT = 512 * 1024 * 1024
MAX_ARCHIVE = 300 * 1024 * 1024
MAX_CHANGE_FILES = 50
MAX_CHANGE_BYTES = 2 * 1024 * 1024
READ_SIZE = 64 * 1024

RUN_ID_PATTERN = re.compile(r'[A-Za-z0-9_-]{1,100}')
REPO_PATTERN = re.compile(r'[a-z0-9][a-z0-9._-]{0,99}')
SHA_PATTERN = re.compile(r'[0-9a-f]{7,64}')
AGENT_INPUT_PATH = re.compile(r'/v1/agent/([^/]+)/input')
REPO_PATH = re.compile(r'/v1/runs/([^/]+)/repos/([^/]+)(/changes)?')
RUN_PATH = re.compile(r'/v1/runs/([^/]+)')

# Environment variables a caller may set for an agent session.
AGENT_ENV_KEYS = {
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'SUPPORT_TOOLS_URL',
    'SUPPORT_RUN_ID',
    'PATH',
    'DISABLE_AUTOUPDATER',
    'ENABLE_TOOL_SEARCH',
    'KUBECONFIG',
}

# Prefix that runs a program as the command user, without any capability.
AS_USER = []
if COMMAND_USER:
    AS_USER = [
        'setpriv',
        f'--reuid={COMMAND_USER}',
        f'--regid={COMMAND_USER}',
        '--init-groups',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--bounding-set=-all',
        '--',
    ]

# pid -> {'run_id': str, 'kill': callable}
running = {}
# run_id -> subprocess.Popen of the agent session
agents = {}
state_lock = threading.Lock()
stdin_lock = threading.Lock()


class Refused(Exception):
    pass


class CommandFailed(Exception):
    def __init__(self, argv, stderr):
        self.stderr = stderr
        super().__init__(f'Command failed: {" ".join(argv)}')


def join(*parts):
    return os.path.normpath(os.path.join(*parts))


def decode(data):
    return data.decode('utf-8', errors='replace')


def program(file, args):
    """Returns the argv that runs file with args as the command user."""
    return [*AS_USER, file, *args]


def run(file, args, env=None):
    """Runs file with args as the command user. Returns stdout as text. Raises CommandFailed on a non-zero exit."""
    argv = program(file, args)
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, env=env)
    if result.returncode != 0:
        raise CommandFailed(argv, decode(result.stderr))
    return decode(result.stdout)


def git(directory, *args):
    """Runs git in directory as the command user, with a fixed author and without hooks."""
    return run('git', [
        '-C', directory,
        '-c', 'user.name=support',
        '-c', 'user.email=support@sandbox',
        '-c', 'core.hooksPath=/dev/null',
        *args,
    ])


def remove_file(path):
    """Deletes a file as the command user. Ignores failures."""
    try:
        run('rm', ['-f', '--', path])
    except (CommandFailed, OSError):
        pass


def inside(path, *roots):
    """True when path is an absolute path inside one of the roots, without parent segments. Empty roots are ignored."""
    if not isinstance(path, str):
        return False
    if not path.startswith('/'):
        return False
    if '..' in path.split('/'):
        return False
    for root in roots:
        if not root:
            continue
        prefix = root.rstrip('/') + '/'
        if path == root or path.startswith(prefix):
            return True
    return False


def to_number(value):
    """Converts numbers and numeric strings to float. Returns 0 for None and empty strings, NaN otherwise."""
    if isinstance(value, (bool, int, float)):
        return float(value)
    if value is None:
        return 0.0
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def timeout_seconds(value, fallback, maximum):
    """Rounds value to whole seconds between 1 and maximum. Uses fallback when value is missing, zero or not a number."""
    seconds = to_number(value)
    if math.isnan(seconds) or seconds == 0:
        seconds = fallback
    if math.isinf(seconds):
        return maximum if seconds > 0 else 1
    seconds = math.floor(seconds + 0.5)
    return min(maximum, max(1, seconds))


def kill_group(pid):
    try:
        os.kill(-pid, signal.SIGKILL)
    except OSError:
        pass


def exit_line(code, signal_name, started, truncated, timeout):
    """Returns the final NDJSON line of a command. timedOut is true when SIGKILL ended the command at or after its timeout."""
    duration_ms = int((time.monotonic() - started) * 1000)
    return {
        'type': 'exit',
        'code': code,
        'signal': signal_name,
        'durationMs': duration_ms,
        'truncated': truncated,
        'timedOut': signal_name == 'SIGKILL' and duration_ms >= timeout * 1000,
    }


def with_newline(text):
    if text.endswith('\n'):
        return text
    return text + '\n'


def to_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def as_object(value):
    """Returns value when it is a JSON object, else an empty dict."""
    if isinstance(value, dict):
        return value
    return {}


class Stream:
    """NDJSON response with chunked transfer encoding. Calls on_disconnect once when the client closes the connection."""

    def __init__(self, handler, on_disconnect):
        self.handler = handler
        self.on_disconnect = on_disconnect
        self.lock = threading.Lock()
        self.ended = False
        self.disconnected = False
        handler.send_response(200)
        handler.send_header('Content-Type', 'application/x-ndjson')
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('Transfer-Encoding', 'chunked')
        handler.end_headers()
        handler.stream = self
        threading.Thread(target=self._watch, daemon=True).start()

    def write(self, value):
        line = (to_json(value) + '\n').encode('utf-8')
        failed = False
        with self.lock:
            if self.ended:
                return
            try:
                self.handler.wfile.write(b'%x\r\n%s\r\n' % (len(line), line))
                self.handler.wfile.flush()
            except OSError:
                failed = True
                self.ended = True
                self.handler.close_connection = True
        if failed:
            self._disconnect()

    def end(self):
        with self.lock:
            if self.ended:
                return
            self.ended = True
            try:
                self.handler.wfile.write(b'0\r\n\r\n')
                self.handler.wfile.flush()
            except OSError:
                self.handler.close_connection = True

    def _disconnect(self):
        with self.lock:
            if self.disconnected:
                return
            self.disconnected = True
        self.on_disconnect()

    def _watch(self):
        """Waits until the client closes the connection or the response ends."""
        sock = self.handler.connection
        while not self.ended:
            readable, _, _ = select.select([sock], [], [], 0.5)
            if not readable:
                continue
            try:
                data = sock.recv(1, socket.MSG_PEEK)
            except OSError:
                data = b''
            if data == b'':
                self._disconnect()
            # Data other than end of file belongs to a next request on the same connection: stop watching.
            return


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.handle_request()

    do_POST = do_GET
    do_PUT = do_GET
    do_DELETE = do_GET
    do_PATCH = do_GET
    do_OPTIONS = do_GET

    def handle_request(self):
        self.stream = None
        self.response_started = False
        self.chunked = 'chunked' in self.headers.get('Transfer-Encoding', '').lower()
        self.body_read = not self.chunked and not self.headers.get('Content-Length')
        try:
            route(self)
        except Exception as error:
            if self.stream is not None:
                self.stream.end()
            elif not self.response_started:
                send_json(self, 500, {'error': str(error)})
        finally:
            # An unread request body would be parsed as the next request.
            if not self.body_read:
                self.close_connection = True

    def body_chunks(self):
        """Yields the request body. Supports Content-Length and chunked transfer encoding."""
        if self.chunked:
            yield from self._chunked_body()
        else:
            remaining = int(self.headers.get('Content-Length') or 0)
            while remaining > 0:
                data = self.rfile.read(min(remaining, READ_SIZE))
                if not data:
                    raise ConnectionError('The client closed the connection.')
                remaining -= len(data)
                yield data
        self.body_read = True

    def _chunked_body(self):
        while True:
            size_line = self.rfile.readline(READ_SIZE)
            if not size_line:
                raise ConnectionError('The client closed the connection.')
            size = int(size_line.split(b';')[0].strip(), 16)
            if size == 0:
                # Skip the optional trailer fields up to the empty line.
                while self.rfile.readline(READ_SIZE) not in (b'\r\n', b'\n', b''):
                    pass
                return
            remaining = size
            while remaining > 0:
                data = self.rfile.read(min(remaining, READ_SIZE))
                if not data:
                    raise ConnectionError('The client closed the connection.')
                remaining -= len(data)
                yield data
            self.rfile.readline(READ_SIZE)


def send_json(handler, status, value):
    body = to_json(value).encode('utf-8')
    handler.response_started = True
    try:
        handler.send_response(status)
        handler.send_header('Content-Type', 'application/json')
        handler.send_header('Content-Length', str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        handler.wfile.flush()
    except OSError:
        handler.close_connection = True


def read_json(handler, limit=MAX_BODY):
    """Parses the request body as JSON. Raises ValueError when the body exceeds limit bytes or is not valid JSON."""
    size = 0
    chunks = []
    for chunk in handler.body_chunks():
        size += len(chunk)
        if size > limit:
            raise ValueError('Request body too large.')
        chunks.append(chunk)
    return json.loads(decode(b''.join(chunks)))


def receive_archive(handler, archive):
    """Writes the request body to archive as the command user. Raises Refused when the body exceeds MAX_ARCHIVE bytes."""
    writer = subprocess.Popen(
        program('sh', ['-c', 'cat > "$1"', 'sh', archive]),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    size = 0
    try:
        for chunk in handler.body_chunks():
            size += len(chunk)
            if size > MAX_ARCHIVE:
                raise Refused('The archive is larger than 300 MB.')
            writer.stdin.write(chunk)
        writer.stdin.close()
    except BaseException:
        writer.kill()
        writer.wait()
        raise
    if writer.wait() != 0:
        raise OSError('write failed')


def upload(handler, run_id, name):
    run_dir = join(RUNS_DIR, run_id)
    repo_dir = join(run_dir, 'repos', name)
    archive = join(run_dir, f'.{name}.tar.gz')

    run('mkdir', ['-p', join(run_dir, 'repos')])
    run('rm', ['-rf', '--', repo_dir])

    try:
        receive_archive(handler, archive)
    except Refused as error:
        remove_file(archive)
        return send_json(handler, 413, {'error': str(error)})
    except Exception:
        remove_file(archive)
        return send_json(handler, 400, {'error': 'The archive upload failed.'})

    try:
        listing = run('tar', ['-tzf', archive])
        for entry in listing.split('\n'):
            if entry.startswith('/') or '..' in entry.split('/'):
                return send_json(handler, 400, {'error': 'The archive contains absolute or parent paths.'})

        run('mkdir', ['-p', repo_dir])
        run('tar', [
            '-xzf', archive,
            '--strip-components=1',
            '--no-same-owner',
            '--no-same-permissions',
            '-C', repo_dir,
        ])

        git(repo_dir, 'init', '-q')
        git(repo_dir, 'add', '-A')
        git(repo_dir, 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'base')

        tracked = git(repo_dir, 'ls-files')
        file_count = len([line for line in tracked.split('\n') if line])
        return send_json(handler, 200, {'path': f'repos/{name}', 'files': file_count})
    except Exception as error:
        detail = getattr(error, 'stderr', '') or str(error)
        last_line = detail.strip().split('\n')[-1]
        return send_json(handler, 400, {'error': 'The archive could not be extracted: ' + last_line})
    finally:
        remove_file(archive)


def resolve_base(directory, requested_base):
    """Returns the commit SHA to compare against. Returns '' when requested_base is not a commit of directory."""
    if requested_base:
        try:
            return git(directory, 'rev-parse', '--verify', requested_base + '^{commit}').strip()
        except CommandFailed:
            return ''

    # A clone marks its starting commit with refs/support/base. An unpacked archive has a single root commit.
    try:
        return git(directory, 'rev-parse', '--verify', '-q', 'refs/support/base^{commit}').strip()
    except CommandFailed:
        roots = git(directory, 'rev-list', '--max-parents=0', 'HEAD')
        return roots.strip().split('\n')[-1]


def changes_in(handler, directory, requested_base=None):
    try:
        git(directory, 'rev-parse', '--verify', 'HEAD')
    except CommandFailed:
        return send_json(handler, 404, {'error': 'No Git repository in this folder. Run repo_checkout or clone it first.'})
    if requested_base is not None and not SHA_PATTERN.fullmatch(requested_base):
        return send_json(handler, 400, {'error': 'base must be a commit SHA.'})

    base = resolve_base(directory, requested_base)
    if not base:
        return send_json(handler, 404, {'error': 'The base commit is not in this repository.'})

    # A temporary index marks untracked files as intent-to-add, so that they appear in the diff. The repository's
    # own index is not modified.
    index = f'/tmp/sandbox-index-{os.getpid()}-{int(time.time() * 1000)}-{secrets.token_hex(6)}'
    index_env = {**os.environ, 'GIT_INDEX_FILE': index}

    def git_with_index(*args):
        return run('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', *args], env=index_env)

    try:
        git_with_index('read-tree', 'HEAD')
        git_with_index('add', '-A', '--intent-to-add')
        status = git_with_index('diff', '--no-renames', '--name-status', '-z', base)
        numstat = git_with_index('diff', '--no-renames', '--numstat', '-z', base)
    finally:
        remove_file(index)

    # git diff --numstat prints "-\t-\t<path>" for binary files.
    binary = set()
    for line in numstat.split('\0'):
        if line.startswith('-\t-\t'):
            binary.add(line.split('\t')[2])

    # git diff --name-status -z prints <status>\0<path>\0 for each file.
    parts = [part for part in status.split('\0') if part]
    entries = []
    for i in range(0, len(parts), 2):
        entries.append({'status': parts[i], 'path': parts[i + 1]})
    if len(entries) > MAX_CHANGE_FILES:
        return send_json(handler, 413, {
            'error': f'{len(entries)} files changed. A proposal can contain at most {MAX_CHANGE_FILES}.',
        })

    files = []
    total_bytes = 0
    for entry in entries:
        path = entry['path']
        if path in binary:
            return send_json(handler, 422, {'error': f'{path} is a binary file. Binary changes cannot be proposed.'})
        if entry['status'] == 'D':
            files.append({'path': path, 'status': 'D', 'content': None})
            continue

        full_path = join(directory, path)
        if stat.S_ISLNK(os.lstat(full_path).st_mode):
            return send_json(handler, 422, {'error': f'{path} is a symlink. Symlinks cannot be proposed.'})

        with open(full_path, 'rb') as file:
            content = file.read()
        total_bytes += len(content)
        if total_bytes > MAX_CHANGE_BYTES:
            return send_json(handler, 413, {'error': 'The changed files exceed 2 MiB.'})
        files.append({'path': path, 'status': entry['status'], 'content': base64.b64encode(content).decode('ascii')})

    return send_json(handler, 200, {'base': base, 'files': files})


def stream_command(handler, run_id, name, args, cwd, env, timeout, output_limit, agent_input=None):
    """Runs name with args as the command user and streams its output as NDJSON.

    Commands from /v1/exec (agent_input is None): stdin is empty. Output above output_limit is dropped and the
    command keeps running.
    Agent sessions (agent_input is a str): stdin stays open for /v1/agent/:runId/input. Output above output_limit
    kills the session.
    """
    is_agent = agent_input is not None
    argv = program(name, args)
    started = time.monotonic()

    try:
        child = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE if is_agent else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as error:
        stream = Stream(handler, on_disconnect=lambda: None)
        code_name = errno.errorcode.get(error.errno, 'UNKNOWN')
        stream.write({'type': 'stderr', 'data': f'Could not start {name}: spawn {argv[0]} {code_name}\n'})
        stream.write(exit_line(-(error.errno or 1), None, started, False, timeout))
        stream.end()
        return

    def kill():
        kill_group(child.pid)

    with state_lock:
        running[child.pid] = {'run_id': run_id, 'kill': kill}
        if is_agent:
            agents[run_id] = child

    if is_agent and agent_input:
        write_stdin(child, agent_input)

    finished = threading.Event()

    # A closed connection means Support stopped waiting: kill the command.
    def on_disconnect():
        if not finished.is_set():
            kill()

    stream = Stream(handler, on_disconnect)
    timer = threading.Timer(timeout, kill)
    timer.daemon = True
    timer.start()

    output = queue.Queue()

    def read_pipe(pipe, kind):
        while True:
            data = os.read(pipe.fileno(), READ_SIZE)
            if not data:
                break
            output.put((kind, data))
        output.put((kind, None))

    # Background jobs keep the output pipes open after the command exits: kill the group so that the pipes close.
    def wait_and_kill():
        child.wait()
        kill()

    threading.Thread(target=read_pipe, args=(child.stdout, 'stdout'), daemon=True).start()
    threading.Thread(target=read_pipe, args=(child.stderr, 'stderr'), daemon=True).start()
    threading.Thread(target=wait_and_kill, daemon=True).start()

    size = 0
    truncated = False
    open_pipes = 2
    while open_pipes:
        kind, data = output.get()
        if data is None:
            open_pipes -= 1
            continue
        if truncated:
            continue
        size += len(data)
        if size <= output_limit:
            stream.write({'type': kind, 'data': decode(data)})
            continue
        truncated = True
        if is_agent:
            kill()
        else:
            remaining = max(0, len(data) - (size - output_limit))
            stream.write({'type': kind, 'data': decode(data[:remaining])})

    child.wait()
    finished.set()
    timer.cancel()
    kill()
    with state_lock:
        running.pop(child.pid, None)
        if is_agent:
            agents.pop(run_id, None)
    child.stdout.close()
    child.stderr.close()

    if child.returncode < 0:
        code = None
        signal_name = signal.Signals(-child.returncode).name
    else:
        code = child.returncode
        signal_name = None
    stream.write(exit_line(code, signal_name, started, truncated, timeout))
    stream.end()


def write_stdin(child, text):
    """Writes text to the agent's stdin, with a final newline. Ignores a closed stdin."""
    with stdin_lock:
        try:
            child.stdin.write(with_newline(text).encode('utf-8'))
            child.stdin.flush()
        except (OSError, ValueError):
            pass


def exec_command(handler):
    try:
        body = read_json(handler)
    except Exception:
        return send_json(handler, 400, {'error': 'Send a JSON body under 64 KiB.'})

    body = as_object(body)
    run_id = body.get('runId')
    command = body.get('command')
    timeout = timeout_seconds(body.get('timeoutSeconds'), 120, MAX_TIMEOUT)
    if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
        return send_json(handler, 400, {'error': 'runId must contain only letters, digits, "_" and "-".'})
    if not isinstance(command, str) or not command.strip() or len(command) > 16000:
        return send_json(handler, 400, {'error': 'command must be a non-empty string under 16,000 characters.'})
    if len(running) >= MAX_RUNNING:
        return send_json(handler, 429, {'error': f'At most {MAX_RUNNING} commands run at the same time.'})

    cwd = join(RUNS_DIR, run_id)
    run('mkdir', ['-p', cwd])
    env = {**os.environ, 'SUPPORT_RUN_ID': run_id}
    stream_command(handler, run_id, 'bash', ['-lc', command], cwd, env, timeout, MAX_OUTPUT)


def start_agent(handler):
    if not AGENT_ROOT:
        return send_json(handler, 404, {'error': 'Agent sessions are disabled. Set SANDBOX_AGENT_ROOT.'})

    try:
        body = read_json(handler, MAX_AGENT_BODY)
    except Exception:
        return send_json(handler, 400, {'error': 'Send a JSON body under 1 MiB.'})

    body = as_object(body)
    run_id = body.get('runId')
    cwd = body.get('cwd')
    args = body.get('args')
    env = body.get('env')
    timeout = timeout_seconds(body.get('timeoutSeconds'), 3600, MAX_AGENT_TIMEOUT)
    if not isinstance(run_id, str) or not RUN_ID_PATTERN.fullmatch(run_id):
        return send_json(handler, 400, {'error': 'runId must contain only letters, digits, "_" and "-".'})
    if run_id in agents:
        return send_json(handler, 409, {'error': 'An agent session already runs with this runId.'})
    if not inside(cwd, AGENT_ROOT):
        return send_json(handler, 400, {'error': 'cwd must be inside SANDBOX_AGENT_ROOT.'})
    valid_args = (
        isinstance(args, list)
        and len(args) <= 200
        and all(isinstance(arg, str) and len(arg) < 200000 for arg in args)
    )
    if not valid_args:
        return send_json(handler, 400, {'error': 'args must be an array of strings.'})

    extra_env = {}
    for key, value in as_object(env).items():
        if key in AGENT_ENV_KEYS and isinstance(value, str) and len(value) < 4096:
            extra_env[key] = value

    if len(running) >= MAX_RUNNING:
        return send_json(handler, 429, {'error': f'At most {MAX_RUNNING} commands run at the same time.'})
    run('mkdir', ['-p', cwd])

    agent_input = body.get('input')
    if not isinstance(agent_input, str):
        agent_input = ''
    stream_command(
        handler,
        run_id,
        'claude',
        args,
        cwd,
        {**os.environ, **extra_env},
        timeout,
        MAX_AGENT_OUTPUT,
        agent_input=agent_input,
    )


def agent_input(handler, run_id):
    child = agents.get(run_id)
    if child is None:
        return send_json(handler, 404, {'error': 'No agent session runs with this runId.'})

    try:
        body = read_json(handler, MAX_AGENT_BODY)
    except Exception:
        return send_json(handler, 400, {'error': 'Send a JSON body under 1 MiB.'})

    body = as_object(body)
    if body.get('end') is True:
        with stdin_lock:
            try:
                child.stdin.close()
            except OSError:
                pass
        return send_json(handler, 200, {'closed': True})

    data = body.get('data')
    if not isinstance(data, str) or not data:
        return send_json(handler, 400, {'error': 'data must be a non-empty string.'})
    write_stdin(child, data)
    return send_json(handler, 200, {'written': True})


def list_changes(handler, query):
    directory = query.get('dir', [''])[0]
    if not inside(directory, AGENT_ROOT, RUNS_DIR):
        return send_json(handler, 400, {'error': 'dir must be inside the agent root or a run folder.'})
    requested_base = query.get('base', [None])[0]
    return changes_in(handler, directory, requested_base)


def kill_all(handler):
    with state_lock:
        entries = list(running.values())
    for entry in entries:
        entry['kill']()
    return send_json(handler, 200, {'killed': len(entries)})


def delete_run(handler, run_id):
    with state_lock:
        entries = [entry for entry in running.values() if entry['run_id'] == run_id]
    for entry in entries:
        entry['kill']()
    run('rm', ['-rf', '--', join(RUNS_DIR, run_id)])
    return send_json(handler, 200, {'deleted': True})


def route(handler):
    url = urlsplit(handler.path)
    method = handler.command
    path = url.path

    if method == 'GET' and path == '/v1/health':
        return send_json(handler, 200, {'ok': True, 'running': len(running)})
    if method == 'POST' and path == '/v1/exec':
        return exec_command(handler)
    if method == 'POST' and path == '/v1/agent':
        return start_agent(handler)

    agent_match = AGENT_INPUT_PATH.fullmatch(path)
    if method == 'POST' and agent_match and RUN_ID_PATTERN.fullmatch(agent_match[1]):
        return agent_input(handler, agent_match[1])

    if method == 'GET' and path == '/v1/changes':
        return list_changes(handler, parse_qs(url.query, keep_blank_values=True))
    if method == 'POST' and path == '/v1/kill-all':
        return kill_all(handler)

    repo_match = REPO_PATH.fullmatch(path)
    if repo_match and RUN_ID_PATTERN.fullmatch(repo_match[1]) and REPO_PATTERN.fullmatch(repo_match[2]):
        run_id, name, changes_suffix = repo_match.groups()
        if method == 'PUT' and not changes_suffix:
            return upload(handler, run_id, name)
        if method == 'GET' and changes_suffix:
            return changes_in(handler, join(RUNS_DIR, run_id, 'repos', name))

    run_match = RUN_PATH.fullmatch(path)
    if method == 'DELETE' and run_match and RUN_ID_PATTERN.fullmatch(run_match[1]):
        return delete_run(handler, run_match[1])

    return send_json(handler, 404, {'error': 'Not found.'})


def stop(signum, frame):
    with state_lock:
        entries = list(running.values())
    for entry in entries:
        entry['kill']()
    os._exit(0)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def handle_error(self, request, client_address):
        """Ignores clients that close the connection. Prints other errors to stderr."""
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


def main():
    server = Server((HOST, int(PORT)), Handler)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'support-sandbox: listening on {HOST}:{PORT}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
