#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// `--version` / `--help` phải TRẢ LỜI RỒI THOÁT, đứng trước mọi thứ khác.
//
// Trước đây CLI không biết hai cờ này: gõ `create-openclaw-bot --version` là nó lờ đi rồi chạy
// tiếp như thường - tạo thư mục project, dựng Setup UI, **chiếm cổng 51789 và treo vĩnh viễn**.
// Đo trên vps_minh-thu 07/09: hai tiến trình `cli.js --version` nằm đó từ 02/09 giữ cổng, nên
// systemd relaunch bản mới xong không bind được cổng - bấm "Cập nhật" thành công mà giao diện
// vẫn là bản cũ, không ai hiểu vì sao.
{
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
    let v = '0.0.0';
    try {
      v = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version || v;
    } catch {}
    console.log(v);
    process.exit(0);
  }
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log([
      'create-openclaw-bot - trình cài đặt OpenClaw Bot',
      '',
      'Cách dùng: create-openclaw-bot [tuỳ chọn]',
      '',
      '  --host=<địa chỉ>      Địa chỉ Setup UI lắng nghe (mặc định 127.0.0.1)',
      '  --port=<cổng>         Cổng Setup UI (mặc định 51789)',
      '  --project-dir=<đường> Thư mục project',
      '  --no-open             Không tự mở trình duyệt',
      '  --allow-admin         (Windows) Cho chạy bằng quyền Administrator thay vì tự mở lại bằng quyền thường',
      '  -v, --version         In phiên bản rồi thoát',
      '  -h, --help            In trợ giúp này rồi thoát',
    ].join('\n'));
    process.exit(0);
  }
}

const runCmd = (cmd, cmdArgs, opts = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { 
      shell: true, 
      stdio: 'inherit',
      ...opts 
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', reject);
  });
};

function isLocalRepo() {
  const pathsToTry = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..')
  ];
  for (const rootDir of pathsToTry) {
    const pkgPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'create-openclaw-bot' && fs.existsSync(path.join(rootDir, 'src', 'cli', 'cli.src.js'))) {
          return true;
        }
      } catch {}
    }
  }
  return false;
}

// True when the full server code is bundled next to this CLI (dist build, npm/global
// install, or `npx github:...`). In that case run it directly instead of bootstrapping
// the published package - works even though `files` ships only `dist/` (no `src/`).
function hasBundledServer() {
  return [
    path.join(__dirname, 'server', 'local-server.js'),
    path.join(__dirname, '..', 'server', 'local-server.js'),
  ].some((p) => fs.existsSync(p));
}

const LOGO = `
╭────────────────────────────────────────╮
│          🦞 OpenClaw Setup 🦞          │
╰────────────────────────────────────────╯
`;
console.log(LOGO);

const args = process.argv.slice(2);

/** True when this process runs elevated (High mandatory level): `whoami /groups` lists S-1-16-12288. */
function windowsElevated() {
  // Full path: with Git's usr/bin first on PATH, `whoami` is the GNU one and rejects /groups.
  const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  try { return /S-1-16-12288/.test(execFileSync(whoami, ['/groups'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })); } catch { return false; }
}

/**
 * Start this same command again at the desktop user's normal level and report whether it started.
 * explorer.exe opens a file with its OWN token, and the desktop explorer is not elevated, so a .cmd
 * it opens is not either. The .cmd writes a marker first, so a relaunch that never ran (no desktop
 * session, explorer itself elevated) is noticed and this process carries on instead of vanishing.
 */
async function relaunchUnelevated() {
  const argv = [process.execPath, __filename, ...args];
  // Anything cmd could misread is refused rather than escaped: stay, with the warning.
  if (argv.some((a) => /["\r\n]/.test(a))) return false;
  const stamp = `${process.pid}-${Date.now()}`;
  const marker = path.join(os.tmpdir(), `openclaw-setup-unelevated-${stamp}.ok`);
  const cmdFile = path.join(os.tmpdir(), `openclaw-setup-unelevated-${stamp}.cmd`);
  const q = (a) => `"${String(a).replace(/%/g, '%%')}"`;
  try {
    fs.writeFileSync(cmdFile, [
      '@echo off',
      'chcp 65001 >nul',
      'title OpenClaw Setup',
      'set "OPENCLAW_SETUP_UNELEVATED=1"',
      `cd /d ${q(process.cwd())}`,
      `echo ok> ${q(marker)}`,
      argv.map(q).join(' '),
      '(goto) 2>nul & del "%~f0"',
    ].join('\r\n') + '\r\n', 'utf8');
    spawn('explorer.exe', [cmdFile], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    return false;
  }
  for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 250));
  const started = fs.existsSync(marker);
  try { fs.rmSync(marker, { force: true }); } catch {}
  if (!started) { try { fs.rmSync(cmdFile, { force: true }); } catch {} }
  return started;
}

// Windows: Setup must not run elevated. Started from a "Run as administrator" terminal, Setup and
// every process it launched - gateway, 9Router - ran elevated (C:\openclaw-setup, 22/10/2026):
// "Dừng Bot" on the Desktop, a normal-user click, could not stop them, and the shortcuts Setup
// wrote came out read-only for the owner. So relaunch at the user's normal level and leave.
// `--allow-admin` keeps an elevated run on purpose.
if (process.platform === 'win32' && !args.includes('--allow-admin') && windowsElevated()) {
  if (process.env.OPENCLAW_SETUP_UNELEVATED !== '1' && (await relaunchUnelevated())) {
    console.log('Setup đã được mở lại bằng quyền thường trong một cửa sổ mới (không chạy bằng quyền Administrator).');
    console.log('Cửa sổ này đóng được.');
    process.exit(0);
  }
  console.warn('⚠️  Setup đang chạy bằng quyền Administrator và không tự mở lại được bằng quyền thường.');
  console.warn('   Bot sẽ chạy bằng quyền admin, nên "Dừng Bot" trên Desktop sẽ không tắt được nó.');
  console.warn('   Nên đóng cửa sổ này và chạy lại lệnh trong cửa sổ thường (không chọn "Run as administrator").');
}

const noOpen = args.includes('--no-open');
// Accept both `--flag=value` and `--flag value`. Only the `=` form used to be read, so a scheduled
// task written as `--project-dir "D:\bot"` silently fell back to C:\openclaw-setup and the UI
// opened the wrong project (win_kha, 08/10/2026). Normalised back to the `=` form below.
const flagArg = (name) => {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq;
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? `${name}=${args[i + 1]}` : undefined;
};
const hostArg = flagArg('--host');
const portArg = flagArg('--port');
const projectDirArg = flagArg('--project-dir');

const fallbackDir = path.join(os.homedir(), 'openclaw-setup');
const defaultProjectDir = process.platform === 'win32'
  ? ((!fs.existsSync('C:\\openclaw-setup') && fs.existsSync(fallbackDir)) ? fallbackDir : 'C:\\openclaw-setup')
  : fallbackDir;

let projectDir = projectDirArg ? projectDirArg.slice('--project-dir='.length) : defaultProjectDir;

if (!fs.existsSync(projectDir)) {
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    console.log(`Folder setup được tạo tại: ${projectDir}`);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      console.warn(`⚠️  Không có quyền tạo thư mục tại: ${projectDir}`);
      console.log(`👉 Đang chuyển sang thư mục mặc định trong User Profile: ${fallbackDir}`);
      try {
        fs.mkdirSync(fallbackDir, { recursive: true });
        projectDir = fallbackDir;
        console.log(`Folder setup được tạo tại: ${projectDir}`);
      } catch (fallbackErr) {
        console.error(`Không thể tự động tạo thư mục project tại ${fallbackDir}:`, fallbackErr.message);
      }
    } else {
      console.error(`Không thể tự động tạo thư mục project tại ${projectDir}:`, err.message);
    }
  }
}

if (process.env.OPENCLAW_SETUP_WIZARD === 'true' || isLocalRepo() || hasBundledServer()) {
  const { startLocalInstaller } = await import('../server/local-server.js');

  await startLocalInstaller({
    openBrowser: !noOpen,
    host: hostArg ? hostArg.slice('--host='.length) : '127.0.0.1',
    // A port that is not 1-65535 (`--port abc`) crashed server.listen with a raw stack.
    preferredPort: (() => { const p = portArg ? Number(portArg.slice('--port='.length)) : 51789; return Number.isInteger(p) && p > 0 && p < 65536 ? p : 51789; })(),
    projectDir: projectDir,
  });
} else {
  const targetDirName = '.openclaw-setup';
  const targetPath = path.join(os.homedir(), targetDirName);
  const cliPath = path.join(targetPath, 'node_modules', 'create-openclaw-bot', 'dist', 'cli.js');
  const shouldUpdate = args.includes('--update');

  try {
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }
    const pkgPath = path.join(targetPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'openclaw-setup-container', version: '1.0.0', private: true, dependencies: {} }, null, 2), 'utf8');
    }

    let needsInstall = !fs.existsSync(cliPath) || shouldUpdate;
    // This repo is distributed from GitHub; `create-openclaw-bot` on npm is the upstream build.
    let installSpec = 'github:dangthanhhung61-dotcom/openclaw-setup-2026.9.8';

    try {
      const runningPkgPath = path.join(__dirname, '..', 'package.json');
      if (fs.existsSync(runningPkgPath)) {
        const runningPkg = JSON.parse(fs.readFileSync(runningPkgPath, 'utf8'));
        if (runningPkg.version) {

          const installedPkgPath = path.join(targetPath, 'node_modules', 'create-openclaw-bot', 'package.json');
          if (fs.existsSync(installedPkgPath)) {
            const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'));
            if (runningPkg.version !== installedPkg.version) {
              console.log(`Version mismatch: Launcher is v${runningPkg.version}, but cached installation is v${installedPkg.version}.`);
              needsInstall = true;
            }
          } else {
            needsInstall = true;
          }
        }
      }
    } catch (err) {}

    if (needsInstall) {
      console.log(`Checking/Installing Setup Wizard package (${installSpec}) in: ${targetPath}...`);
      await runCmd('npm', ['install', installSpec, '--no-audit', '--no-fund'], { cwd: targetPath });
    }

    console.log('\nStarting Setup Wizard...');
    const cleanArgs = args.filter((arg) => arg !== '--update');
    
    const child = spawn(process.argv[0], [cliPath, ...cleanArgs, `--project-dir=${projectDir}`], {
      cwd: targetPath,
      shell: false,
      stdio: 'inherit',
      env: {
        ...process.env,
        OPENCLAW_SETUP_WIZARD: 'true'
      }
    });
    child.on('close', (code) => {
      process.exit(code);
    });
  } catch (error) {
    console.error('\n❌ Lỗi khi khởi động Setup Wizard:', error.message);
    process.exit(1);
  }
}


