'use strict';

/**
 * Double-click launchers for a NATIVE bot on Windows.
 *
 * Why these exist instead of a Scheduled Task: `openclaw daemon install` creates a task with
 * `LogonType: Interactive`, which means the gateway is tied to whoever's login session started
 * it. Two consequences measured on win_kha (10/09/2026):
 *   • anything started over SSH dies the moment the session closes (LastTaskResult 0xC000013A);
 *   • a task set to run at boot is refused outright, because "at startup" and "only while
 *     someone is logged in" contradict each other (0x800710E0).
 * Making it run without a login needs the account password stored in the task - Task Scheduler
 * rejected that too ("The user account is unknown, the password is incorrect"). So the owner
 * drives it by hand, exactly like the .command files on macOS.
 *
 * Every trap below cost a round trip with a customer waiting, so they are encoded here:
 *
 *  1. `.cmd` MUST be CRLF. LF-only files break on Windows.
 *  2. Never name a launcher after the command it calls. `9router.cmd` in the project dir plus
 *     `cd /d <project>` makes `call 9router` re-enter the same file - BATCH RECURSION, and the
 *     process dies before doing anything.
 *  3. Never append to a fixed log file. 9router holds its log open for its whole lifetime, so
 *     the SECOND run cannot open it and exits with "The process cannot access the file because
 *     it is being used by another process" - invisible on the first run, which is why it is easy
 *     to ship broken.
 *  4. 9router shows a `Choose Interface` menu when its stdout looks like a real console. Started
 *     hidden, nobody can answer it, so it hangs and never opens its port. `> NUL` is what tells
 *     it to run unattended. Symptom without it: works when run by hand, silently dead in the
 *     background - same command.
 *  5. `Start-Process -WindowStyle Hidden` does NOT hide a console a .cmd opens for itself. Only
 *     WScript.Shell.Run(..., 0, False) truly hides it. Leaving a visible window is not cosmetic:
 *     it IS the bot, and closing it kills the bot.
 *  6. Anchor the working directory. Agents may carry relative workspace paths, which resolve
 *     against the launcher's cwd - move the files into a folder and those bots die with
 *     WORKSPACE_VANISHED while the others keep working.
 */

const CRLF = (s) => s.replace(/\r?\n/g, '\r\n');

/** Hidden-launch helper. WScript is the only reliable way to start a .cmd with no window. */
function buildRunHiddenVbs() {
  return CRLF(
    'Set sh = CreateObject("WScript.Shell")\n' +
    'sh.Run "cmd /c """ & WScript.Arguments(0) & """", 0, False\n',
  );
}

/** Starts 9router. Named start-9router.cmd on purpose - see trap 2. */
function build9RouterCmd({ projectDir, routerPort }) {
  return CRLF(
    '@echo off\n' +
    'rem Ten tep KHONG duoc la "9router.cmd": trung ten thi lenh ben duoi goi lai chinh no.\n' +
    'rem "> NUL" la bat buoc: neu dau ra la man hinh that, 9router bay menu "Choose Interface"\n' +
    'rem roi cho nguoi chon va khong bao gio mo cong.\n' +
    `cd /d ${projectDir}\n` +
    `set "DATA_DIR=${projectDir}\\.9router"\n` +
    `call 9router -n -l -H 127.0.0.1 -p ${routerPort} --skip-update > NUL 2>&1\n`,
  );
}

/**
 * The node host that gives the bot screen control.
 *
 * Two things here are not obvious and both cost a day:
 *  - It runs against `<project>\.openclaw-node`, NOT the bot's state dir. Pointed at the bot's, it
 *    loads the bot's plugins too, and zalo-mod's dashboard port is already held by the gateway, so
 *    the node dies on `listen EADDRINUSE 127.0.0.1:18790` before publishing computer.act.
 *  - It is launched as a .cmd through wscript like everything else on Windows. Spawning the
 *    `openclaw.cmd` shim from Node with detached+shell fails outright with `spawn EINVAL`.
 */
function buildNodeHostCmd({ projectDir, gatewayPort, gatewayToken }) {
  return CRLF(
    '@echo off\n' +
    'rem Node host cho tinh nang dieu khien may (tool computer/screen cua OpenClaw).\n' +
    `cd /d ${projectDir}\n` +
    'set "HOME=%USERPROFILE%"\n' +
    `set "OPENCLAW_HOME=${projectDir}\\.openclaw-node"\n` +
    `set "OPENCLAW_STATE_DIR=${projectDir}\\.openclaw-node"\n` +
    (gatewayToken ? `set "OPENCLAW_GATEWAY_TOKEN=${gatewayToken}"\n` : '') +
    '"%ProgramFiles%\\nodejs\\node.exe" ' +
    '"%APPDATA%\\npm\\node_modules\\openclaw\\dist\\index.js" ' +
    `node run --host 127.0.0.1 --port ${gatewayPort} --no-tls\n`,
  );
}

/** Starts the gateway. Calls node directly - see the --task-supervisor note below. */
function buildGatewayCmd({ projectDir, gatewayPort, stateDir }) {
  return CRLF(
    '@echo off\n' +
    'rem Goi thang node, KHONG qua gateway.cmd cua openclaw: tep do chay kem --task-supervisor,\n' +
    'rem no di tim Scheduled Task de ban giao; khong co task thi no de them tien trinh + cua so.\n' +
    'rem Khong redirect ra tep co dinh (xem trap 3) - openclaw tu ghi nhat ky trong %TEMP%\\openclaw.\n' +
    `cd /d ${projectDir}\n` +
    'set "HOME=%USERPROFILE%"\n' +
    // Name the state dir outright. Setting only HOME works when the state was moved to
    // %USERPROFILE%\.openclaw (the >=2026.8 layout prepareNativeStateHome sets up), and silently
    // does not when it was left in the project: the gateway then finds no config and exits with
    // "Missing config. Run `openclaw setup`", which reads like a broken install rather than a
    // launcher looking in the wrong place. Measured on win_phuc, 12/09/2026, after a migration
    // that stopped before the state move. This value is the resolved path, so it is right under
    // both layouts (the project copy may be a junction, and 2026.8 fs-safe refuses those).
    `set "OPENCLAW_HOME=${stateDir}"\n` +
    `set "OPENCLAW_STATE_DIR=${stateDir}"\n` +
    `set "OPENCLAW_GATEWAY_PORT=${gatewayPort}"\n` +
    `set "OPENCLAW_PORT=${gatewayPort}"\n` +
    '"%ProgramFiles%\\nodejs\\node.exe" --max-old-space-size=8192 ' +
    `"%APPDATA%\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port ${gatewayPort}\n`,
  );
}

function buildSetupUiCmd({ projectDir, setupPort, setupCommand }) {
  // Relaunch the SAME Setup that wrote this file. Always calling npx meant a Setup run from a local
  // checkout was replaced by the published build at the next "Mở giao diện" - its fixes vanished and
  // the old build put the four Desktop files back on its next restart (C:\bot, 17/10/2026).
  const launch = setupCommand || 'npx --yes create-openclaw-bot';
  return CRLF(
    '@echo off\n' +
    'rem Ten tep nhat ky kem gio, de lan chay sau khong dung vao tep dang bi giu (trap 3).\n' +
    `cd /d ${projectDir}\n` +
    'for /f "tokens=1-4 delims=/: " %%a in ("%TIME%") do set "T=%%a%%b%%c"\n' +
    // `--yes` is not optional. Whenever the installed version differs from what npx resolves - which
    // is EVERY time a new version is published - npx stops at "Need to install the following
    // packages ... Ok to proceed? (y)". The launcher runs hidden, so nobody can answer it: the
    // window sits there forever and the dashboard simply never opens. Measured on a customer
    // machine, where it looked like the tunnel was broken rather than a prompt waiting offscreen.
    `call ${launch} --host=127.0.0.1 --port=${setupPort} --no-open --project-dir=${projectDir}` +
    ` > "${projectDir}\\setup-ui-%T%.log" 2>&1\n`,
  );
}

function buildStartBotCmd({ projectDir, gatewayPort, routerPort }) {
  const dashPort = gatewayPort + 1;
  return CRLF(
    '@echo off\n' +
    'title Khoi dong bot OpenClaw\n' +
    'color 0A\n' +
    `cd /d ${projectDir}\n` +
    'echo.\n' +
    'echo   ============================================\n' +
    `echo      KHOI DONG BOT  --  ${projectDir}\n` +
    'echo   ============================================\n' +
    'echo.\n' +
    'echo   Dang bat 9Router...\n' +
    `powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort ${routerPort} -State Listen -EA SilentlyContinue)) { Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\start-9router.cmd' -WindowStyle Hidden }" >nul 2>&1\n` +
    'echo   Cho 9Router san sang...\n' +
    `powershell -NoProfile -Command "for($i=0;$i -lt 20;$i++){ try{ Invoke-WebRequest 'http://127.0.0.1:${routerPort}/' -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep -Seconds 2 } }"\n` +
    'echo   Dang bat bot (gateway)...\n' +
    // A gateway spends 1.5-3 min booting before it listens; one started meanwhile fights it for the
    // state dir (300s ownership wait, then exit - win C:\bot 17/10/2026 13:07). So a gateway PROCESS
    // for this port counts as "already running", not only a listening port.
    `powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort ${gatewayPort} -State Listen -EA SilentlyContinue) -and -not (Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*openclaw*gateway --port ${gatewayPort}*' })) { Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\gateway-start.cmd' -WindowStyle Hidden }" >nul 2>&1\n` +
    'echo   Cho bot san sang (co the mat 1-3 phut)...\n' +
    'echo.\n' +
    `powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 80;$i++){ try{ Invoke-WebRequest 'http://127.0.0.1:${gatewayPort}/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; $ok=$true; break } catch { Start-Sleep -Seconds 3 } }; if($ok){ Write-Host '   [OK] Bot da chay.' -ForegroundColor Green } else { Write-Host '   [LOI] Bot chua len.' -ForegroundColor Red }"\n` +
    // Bring screen control back up too. The node host dies with the login session like everything
    // else, and nothing else restarts it: PC control would quietly stop working after every logout
    // or reboot, with the dashboard still showing it as ON. Only start it when .openclaw-node
    // exists - that directory is written when the operator turns PC control on, so a project that
    // never enabled it starts nothing extra.
    `if exist "${projectDir}\\.openclaw-node\\openclaw.json" (\n` +
    '  echo   Dang bat dieu khien may...\n' +
    `  powershell -NoProfile -Command "if (-not (Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*node*run*--host*' })) { Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\node-host.cmd' -WindowStyle Hidden }" >nul 2>&1\n` +
    ')\n' +
    'echo.\n' +
    'echo   --- Trang thai ---\n' +
    `powershell -NoProfile -Command "foreach($x in @(@('Bot (gateway)','http://127.0.0.1:${gatewayPort}/health'),@('9Router','http://127.0.0.1:${routerPort}/'),@('Bang dieu khien Zalo','http://127.0.0.1:${dashPort}/dashboard'))){ try{ (Invoke-WebRequest $x[1] -UseBasicParsing -TimeoutSec 6) | Out-Null; Write-Host ('   {0,-22} DANG CHAY' -f $x[0]) -ForegroundColor Green } catch { Write-Host ('   {0,-22} TAT' -f $x[0]) -ForegroundColor Red } }"\n` +
    'echo.\n' +
    'echo   Bot chay AN, khong co cua so nao de lo tay dong.\n' +
    'echo   Bot chi tat khi ban DANG XUAT / TAT may, hoac bam "3 - DUNG BOT".\n' +
    'echo.\n' +
    'timeout /t 12 >nul\n',
  );
}

function buildOpenUiCmd({ projectDir, setupPort }) {
  return CRLF(
    '@echo off\n' +
    'title Mo giao dien bot\n' +
    'color 0B\n' +
    `cd /d ${projectDir}\n` +
    'echo.\n' +
    'echo   ============================================\n' +
    'echo      MO GIAO DIEN QUAN TRI BOT\n' +
    'echo   ============================================\n' +
    'echo.\n' +
    `powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort ${setupPort} -State Listen -EA SilentlyContinue)) { Write-Host '   Dang bat giao dien...'; Start-Process wscript -ArgumentList '${projectDir}\\run-hidden.vbs','${projectDir}\\setup-ui.cmd' -WindowStyle Hidden } else { Write-Host '   Giao dien dang chay san.' }"\n` +
    'echo   Cho giao dien san sang...\n' +
    `powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ try{ Invoke-WebRequest 'http://127.0.0.1:${setupPort}/' -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep -Seconds 2 } }"\n` +
    `start "" http://127.0.0.1:${setupPort}\n` +
    'echo.\n' +
    'echo   Da mo trinh duyet. Dong cua so nay duoc roi.\n' +
    'timeout /t 8 >nul\n',
  );
}

function buildStopBotCmd({ gatewayPort, routerPort }) {
  return CRLF(
    '@echo off\n' +
    'title Dung bot OpenClaw\n' +
    'color 0C\n' +
    'echo.\n' +
    'echo   Dang dung bot va 9Router...\n' +
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*openclaw*gateway*\' -or $_.CommandLine -like \'*9router*\' } | ForEach-Object { Write-Host (\'   dung PID \' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"\n' +
    'echo.\n' +
    `powershell -NoProfile -Command "Start-Sleep -Seconds 3; foreach($x in @(@('Bot',${gatewayPort}),@('9Router',${routerPort}))){ $c=Get-NetTCPConnection -LocalPort $x[1] -State Listen -EA SilentlyContinue; if($c){ Write-Host ('   {0,-10} VAN CHAY' -f $x[0]) -ForegroundColor Yellow } else { Write-Host ('   {0,-10} da tat' -f $x[0]) -ForegroundColor Green } }"\n` +
    'echo.\n' +
    'pause\n',
  );
}

/**
 * One-click control for the owner. The Desktop used to get four loose files (this readme plus the
 * three .cmd launchers) - customers found that ugly and confusing (17/10/2026). Now the Desktop gets
 * ONE shortcut with the OpenClaw icon ("Khởi động Bot") and the rest live in a Start Menu folder.
 *
 * bot-control.ps1 does what "1 - KHOI DONG BOT" / "3 - DUNG BOT" do, but hidden, and reports through
 * a Windows notification instead of a console. It carries a UTF-8 BOM: Windows PowerShell 5.1 reads
 * a BOM-less script as ANSI and mangles the Vietnamese text. It holds a named mutex so a double
 * click cannot start two gateways (they fight over the state dir and one dies after 300 s).
 */
function buildBotControlPs1({ gatewayPort, routerPort }) {
  return '﻿' + CRLF(`# Dieu khien bot OpenClaw bang mot cu bam (loi tat "Khởi động Bot" tren Desktop / Start Menu).
# Chay ngam, khong cua so; bao ket qua bang thong bao Windows co logo. Tep do Setup sinh ra - dung sua tay.
#   -Action start : bat 9Router + bot (gateway) neu chua chay, doi bot san sang.
#   -Action stop  : tat bot va 9Router.
param([ValidateSet('start', 'stop')][string]$Action = 'start')

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$icon = Join-Path $root 'assets\\openclaw-bot.ico'
$gwPort = ${gatewayPort}
$rtPort = ${routerPort}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = if (Test-Path $icon) { New-Object System.Drawing.Icon $icon } else { [System.Drawing.SystemIcons]::Information }
$tray.Text = 'Bot OpenClaw'
$tray.Visible = $true

function Notify([string]$text, [string]$kind = 'Info', [int]$holdSec = 0) {
  $tray.BalloonTipTitle = 'Bot OpenClaw'
  $tray.BalloonTipText = $text
  $tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$kind
  $tray.ShowBalloonTip(5000)
  if ($holdSec -gt 0) { Start-Sleep -Seconds $holdSec }
}
function Test-Listening([int]$port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue) }
function Get-NodeProcess([string]$like) { Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like $like } }
function Test-Healthy {
  try { Invoke-WebRequest "http://127.0.0.1:$gwPort/health" -UseBasicParsing -TimeoutSec 3 | Out-Null; $true } catch { $false }
}
function Start-Hidden([string]$cmd) {
  Start-Process wscript -ArgumentList (Join-Path $root 'run-hidden.vbs'), (Join-Path $root $cmd) -WindowStyle Hidden
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\\OpenClawBotControl')
if (-not $mutex.WaitOne(0)) {
  Notify 'Đang xử lý lần bấm trước, đợi chút nhé.' 'Info' 6
  $tray.Dispose()
  exit
}
try {
  if ($Action -eq 'stop') {
    Get-NodeProcess '*openclaw*gateway*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Get-NodeProcess '*9router*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 3
    if (Test-Listening $gwPort) { Notify 'Bot vẫn còn chạy - bấm "Dừng Bot" lần nữa.' 'Warning' 8 }
    else { Notify 'Đã dừng bot.' 'Info' 6 }
    return
  }

  if (Test-Healthy) { Notify 'Bot đang chạy rồi.' 'Info' 6; return }
  Notify 'Đang khởi động bot... (khoảng 1-3 phút)'

  if (-not (Test-Listening $rtPort)) {
    Start-Hidden 'start-9router.cmd'
    for ($i = 0; $i -lt 20 -and -not (Test-Listening $rtPort); $i++) { Start-Sleep -Seconds 2 }
  }
  # Mot gateway dang khoi dong chua mo cong: coi nhu da chay, dung bat them cai thu hai.
  if (-not (Test-Listening $gwPort) -and -not (Get-NodeProcess "*openclaw*gateway --port $gwPort*")) {
    Start-Hidden 'gateway-start.cmd'
  }

  $ok = $false
  for ($i = 0; $i -lt 80; $i++) { if (Test-Healthy) { $ok = $true; break }; Start-Sleep -Seconds 3 }

  if ($ok -and (Test-Path (Join-Path $root '.openclaw-node\\openclaw.json')) -and -not (Get-NodeProcess '*node*run*--host*')) {
    Start-Hidden 'node-host.cmd'
  }
  if ($ok) { Notify 'Bot đã sẵn sàng ✅' 'Info' 8 }
  else { Notify 'Bot chưa lên sau 4 phút. Mở "Mở giao diện quản trị" để xem lỗi.' 'Warning' 10 }
}
finally {
  $mutex.ReleaseMutex()
  $tray.Visible = $false
  $tray.Dispose()
}
`);
}

/** Runs bot-control.ps1 with no window at all - a shortcut straight to powershell.exe flashes a console. */
function buildBotControlVbs() {
  return CRLF(
    "' Runs bot-control.ps1 hidden. Usage: wscript bot-control.vbs [start|stop]\n" +
    'Set sh = CreateObject("WScript.Shell")\n' +
    'Set fso = CreateObject("Scripting.FileSystemObject")\n' +
    'here = fso.GetParentFolderName(WScript.ScriptFullName)\n' +
    'action = "start"\n' +
    'If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)\n' +
    'sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\\bot-control.ps1"" -Action " & action, 0, False\n',
  );
}

/**
 * Shortcuts Setup creates (local-server installWindowsShortcuts). Desktop: exactly one. A project
 * folder other than "bot" gets its name appended, so two projects on one machine do not overwrite
 * each other's shortcuts.
 */
function buildWindowsShortcutSpecs({ projectDir }) {
  const base = String(projectDir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const suffix = base && base.toLowerCase() !== 'bot' ? ` (${base})` : '';
  const vbs = `"${projectDir}\\bot-control.vbs"`;
  const start = { name: `Khởi động Bot${suffix}`, target: 'wscript', args: `${vbs} start`, desc: 'Bấm một lần để khởi động bot OpenClaw' };
  return {
    projectDir,
    icon: `${projectDir}\\assets\\openclaw-bot.ico`,
    folder: `Bot OpenClaw${suffix}`,
    desktop: [start],
    startMenu: [
      start,
      { name: 'Dừng Bot', target: 'wscript', args: `${vbs} stop`, desc: 'Tắt bot OpenClaw và 9Router' },
      { name: 'Mở giao diện quản trị', target: 'wscript', args: `"${projectDir}\\run-hidden.vbs" "${projectDir}\\2 - MO GIAO DIEN.cmd"`, desc: 'Mở trang quản trị bot trong trình duyệt' },
      { name: 'Hướng dẫn', target: 'notepad', args: `"${projectDir}\\0 - DOC TRUOC.txt"`, desc: 'Hướng dẫn dùng bot' },
    ],
    legacy: WINDOWS_LEGACY_DESKTOP_FILES,
  };
}

function buildReadme({ projectDir, gatewayPort, routerPort, setupPort }) {
  return CRLF(
    'BOT OPENCLAW TREN MAY NAY - HUONG DAN NHANH\n' +
    '===========================================\n\n' +
    'Tren Desktop co MOT bieu tuong co logo: "Khoi dong Bot". Bam dup la bot chay ngam,\n' +
    'goc man hinh bao "Bot da san sang" khi xong (1-3 phut).\n\n' +
    'Cac lenh khac nam trong Start Menu > thu muc "Bot OpenClaw":\n' +
    '  Khoi dong Bot              Bat bot len. Bam sau moi lan khoi dong may.\n' +
    '  Mo giao dien quan tri      Mo trang quan tri bot trong trinh duyet.\n' +
    '  Dung Bot                   Tat bot (chi dung khi can).\n\n' +
    'Ban cu (cua so den, co bao trang thai) van nam trong ' + projectDir + ':\n' +
    '  1 - KHOI DONG BOT.cmd, 2 - MO GIAO DIEN.cmd, 3 - DUNG BOT.cmd\n\n' +
    'QUAN TRONG\n' +
    '----------\n' +
    '- Bot chay AN hoan toan: khong co cua so den nao nam tren man hinh.\n' +
    '- Bot KHONG tu chay khi bat may. Sau moi lan khoi dong lai may,\n' +
    '  bam "Khoi dong Bot" mot lan la xong.\n' +
    '- Bot se tat khi ban DANG XUAT hoac TAT may.\n' +
    '- Cac tep .cmd dat o dau cung duoc, chung deu neo ve ' + projectDir + '.\n\n' +
    'Cong dang dung:\n' +
    `  ${gatewayPort}  bot (gateway)\n` +
    `  ${gatewayPort + 1}  bang dieu khien Zalo\n` +
    `  ${routerPort}  9Router\n` +
    `  ${setupPort}  giao dien quan tri\n`,
  );
}

/** All launcher files for a native Windows project, as { relativeName: content }. */
function buildWindowsLaunchers({ projectDir, gatewayPort = 18789, routerPort = 20128, setupPort = 51789, gatewayToken = '', stateDir = '', setupCommand = '' }) {
  const opts = { projectDir, gatewayPort, routerPort, setupPort, gatewayToken, stateDir: stateDir || `${projectDir}\\.openclaw`, setupCommand };
  return {
    'run-hidden.vbs': buildRunHiddenVbs(),
    'start-9router.cmd': build9RouterCmd(opts),
    'gateway-start.cmd': buildGatewayCmd(opts),
    'node-host.cmd': buildNodeHostCmd(opts),
    'setup-ui.cmd': buildSetupUiCmd(opts),
    '0 - DOC TRUOC.txt': buildReadme(opts),
    '1 - KHOI DONG BOT.cmd': buildStartBotCmd(opts),
    '2 - MO GIAO DIEN.cmd': buildOpenUiCmd(opts),
    '3 - DUNG BOT.cmd': buildStopBotCmd(opts),
    'bot-control.ps1': buildBotControlPs1(opts),
    'bot-control.vbs': buildBotControlVbs(),
  };
}

/** Files older Setup versions copied onto the Desktop; installWindowsShortcuts recycles the ones it made. */
const WINDOWS_LEGACY_DESKTOP_FILES = ['0 - DOC TRUOC.txt', '1 - KHOI DONG BOT.cmd', '2 - MO GIAO DIEN.cmd', '3 - DUNG BOT.cmd'];

const api = { buildWindowsLaunchers, buildWindowsShortcutSpecs, WINDOWS_LEGACY_DESKTOP_FILES };
if (typeof globalThis !== 'undefined') globalThis.__openclawWindowsLaunchers = api;
if (typeof exports !== 'undefined') Object.assign(exports, api);
