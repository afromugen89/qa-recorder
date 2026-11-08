// Builds a portable, self-contained copy of QA Recorder that runs without
// Node, npm or Playwright installed. Run it on the platform you are building
// for (Windows for the Windows zip):
//
//   npm run package
//
// Output: release/QA-Recorder-<version>-<platform>-<arch>/ and a .zip
// (Windows) or .tar.gz (macOS/Linux) of it.
//
// Layout of the package:
//   QA Recorder.cmd      double-click launcher (asks for a URL)
//   qa-recorder.cmd      command-line launcher, takes the usual arguments
//   README.txt
//   runtime/node(.exe)   the Node.js that ran this script
//   app/dist             compiled recorder
//   app/node_modules     production dependencies, with Chromium inside
//                        playwright-core/.local-browsers
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const isWin = process.platform === 'win32';
const name = `QA-Recorder-${pkg.version}-${isWin ? 'win' : process.platform}-${process.arch}`;
const releaseDir = join(root, 'release');
const out = join(releaseDir, name);
const app = join(out, 'app');
const skipArchive = process.argv.includes('--no-archive');

function run(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', shell: isWin && /\.cmd$|^npm$|^npx$/.test(cmd), ...options });
}

console.log(`Packaging ${name}`);
rmSync(out, { recursive: true, force: true });
rmSync(`${out}.zip`, { force: true });
rmSync(`${out}.tar.gz`, { force: true });
mkdirSync(app, { recursive: true });

// 1. Compile.
run('npm', ['run', 'build'], { cwd: root });
cpSync(join(root, 'dist'), join(app, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });

// 2. Production dependencies only, from the lockfile.
const appPkg = { ...pkg, scripts: {}, devDependencies: {} };
writeFileSync(join(app, 'package.json'), JSON.stringify(appPkg, null, 2));
cpSync(join(root, 'package-lock.json'), join(app, 'package-lock.json'));
run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: app });

// 3. Chromium, stored inside node_modules so the folder is self-contained.
//    The launchers set PLAYWRIGHT_BROWSERS_PATH=0 so Playwright looks there.
run(process.execPath, [join(app, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], {
  cwd: app,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
});

// 4. The Node.js runtime: the one running this script.
mkdirSync(join(out, 'runtime'));
const nodeName = isWin ? 'node.exe' : 'node';
cpSync(process.execPath, join(out, 'runtime', nodeName));

// 5. Launchers and readme.
const readme = `QA Recorder ${pkg.version}
${'='.repeat(`QA Recorder ${pkg.version}`.length)}

A recording browser for QA. Nothing else needs to be installed: Node.js and
Chromium are included in this folder.

Start
-----
${isWin ? 'Double-click "QA Recorder.cmd".' : 'Run ./qa-recorder.sh record'} Type the address of the site to test
(or leave it empty), press Enter, and test as normal. Close the browser
window to finish.

Press Alt+Shift+D to switch between the site and the QA tools window.

Where things are saved
----------------------
Recordings, bug reports, data profiles and API mocks are saved in
${isWin ? '%USERPROFILE%\\QA Recorder' : '~/QA Recorder'}, so they are kept when you update to a newer version.
To use another folder, set the QA_RECORDER_HOME environment variable.

Command line
------------
${isWin ? 'qa-recorder.cmd' : './qa-recorder.sh'} takes the same commands as the developer version, e.g.
  ${isWin ? 'qa-recorder.cmd' : './qa-recorder.sh'} record https://example.com --slow 500
  ${isWin ? 'qa-recorder.cmd' : './qa-recorder.sh'} --help

Updating
--------
Delete this folder and unzip the new version. Your recordings are not in it.
`;
writeFileSync(join(out, 'README.txt'), isWin ? readme.replace(/\n/g, '\r\n') : readme);

if (isWin) {
  const env = [
    '@echo off',
    'setlocal',
    'set "QA_DIR=%~dp0"',
    'set "PLAYWRIGHT_BROWSERS_PATH=0"',
    'if not defined QA_RECORDER_HOME set "QA_RECORDER_HOME=%USERPROFILE%\\QA Recorder"',
    'if not exist "%QA_RECORDER_HOME%" mkdir "%QA_RECORDER_HOME%"',
    'cd /d "%QA_RECORDER_HOME%"',
  ];
  const node = '"%QA_DIR%runtime\\node.exe" "%QA_DIR%app\\dist\\cli.js"';
  const gui = [
    ...env,
    'title QA Recorder',
    'echo QA Recorder - recordings are saved in %QA_RECORDER_HOME%',
    'echo.',
    'set "QA_URL="',
    'set /p "QA_URL=Site to test (press Enter for a blank page): "',
    `${node} record %QA_URL%`,
    'echo.',
    'echo Recording finished. Opening the recordings folder...',
    'if exist "%QA_RECORDER_HOME%\\recordings" start "" explorer "%QA_RECORDER_HOME%\\recordings"',
    'pause',
    '',
  ];
  const cli = [...env, `${node} %*`, 'exit /b %ERRORLEVEL%', ''];
  writeFileSync(join(out, 'QA Recorder.cmd'), gui.join('\r\n'));
  writeFileSync(join(out, 'qa-recorder.cmd'), cli.join('\r\n'));
} else {
  const sh = `#!/bin/sh
QA_DIR="$(cd "$(dirname "$0")" && pwd)"
export PLAYWRIGHT_BROWSERS_PATH=0
: "\${QA_RECORDER_HOME:=$HOME/QA Recorder}"
mkdir -p "$QA_RECORDER_HOME" && cd "$QA_RECORDER_HOME" || exit 1
exec "$QA_DIR/runtime/node" "$QA_DIR/app/dist/cli.js" "$@"
`;
  writeFileSync(join(out, 'qa-recorder.sh'), sh);
  chmodSync(join(out, 'qa-recorder.sh'), 0o755);
}

// 6. Archive.
if (!skipArchive) {
  if (isWin) {
    // bsdtar ships with Windows 10+ and writes zip files with -a.
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    run(tar, ['-a', '-c', '-f', `${name}.zip`, name], { cwd: releaseDir });
  } else {
    run('tar', ['-czf', `${name}.tar.gz`, name], { cwd: releaseDir });
  }
}

if (!existsSync(join(app, 'dist', 'cli.js'))) throw new Error('Package is missing app/dist/cli.js');
console.log(`\nDone: ${skipArchive ? out : join(releaseDir, name + (isWin ? '.zip' : '.tar.gz'))}`);
