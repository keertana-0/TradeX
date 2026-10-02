const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const service = path.join(root, 'services', 'stock-analysis');
const venv = path.join(service, '.venv');
const venvPython = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');
const action = process.argv[2];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function locatePython() {
  const candidates = process.env.PYTHON_EXECUTABLE
    ? [process.env.PYTHON_EXECUTABLE]
    : process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  fail('Python was not found. Install Python 3.9+ or set PYTHON_EXECUTABLE to its full path.');
}

function runSync(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}

if (action === 'install') {
  if (!fs.existsSync(venvPython)) runSync(locatePython(), ['-m', 'venv', venv]);
  runSync(venvPython, ['-m', 'pip', 'install', '-r', path.join(service, 'requirements.txt')]);
} else if (action === 'start') {
  if (!fs.existsSync(venvPython)) fail('The Python environment is missing. Run npm run python:install first.');
  const child = spawn(venvPython, [path.join(service, 'app.py')], { cwd: service, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => fail(error.message));
  child.on('exit', (code, signal) => { process.exitCode = code || (signal ? 1 : 0); });
} else if (action === 'test') {
  if (!fs.existsSync(venvPython)) fail('The Python environment is missing. Run npm run python:install first.');
  runSync(venvPython, ['-m', 'unittest', 'discover', '-s', 'tests'], service);
} else {
  fail('Usage: node scripts/python-env.js install|start|test');
}
