<#
install-cc.ps1 —— 把 cc 命令装进用户 PATH

⚠️ 必须在【普通 PowerShell】里跑，不要在受限的 agent 会话里跑。
   受限环境对 %LOCALAPPDATA%、用户 PATH 注册表通常拒绝写入。

用法：
  powershell -ExecutionPolicy Bypass -File install-cc.ps1 -DryRun   # 只打印要做什么
  powershell -ExecutionPolicy Bypass -File install-cc.ps1           # 真装
  powershell -ExecutionPolicy Bypass -File install-cc.ps1 -Uninstall

做的事（全部可回滚）：
  1. 把 tools\ 下的 cc.ps1 / cc-run.ps1 复制到 %LOCALAPPDATA%\cc\
  2. 在用户 PATH 里加一条 %LOCALAPPDATA%\cc
  3. 在 $PROFILE 里加一个 cc 函数别名（如果已存在则跳过）
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$SrcDir  = Join-Path $PSScriptRoot ''
$DestDir = Join-Path $env:LOCALAPPDATA 'cc'
$Marker  = '# >>> claude-dsh-bridge: cc >>>'
$MarkerEnd = '# <<< claude-dsh-bridge: cc <<<'

function Say($m)  { Write-Host "[install] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[install] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[install] $m" -ForegroundColor Red; exit 1 }

# ---------- 前置检查 ----------
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Warn '找不到 claude 命令。cc 装了也用不了，先确认 Claude Code CLI 在 PATH 里。'
}
foreach ($f in @('cc.ps1', 'cc-run.ps1')) {
    if (-not (Test-Path (Join-Path $SrcDir $f))) { Die "源文件缺失: $f" }
}

# ---------- 卸载 ----------
if ($Uninstall) {
    Say '开始卸载'
    if ($DryRun) {
        Say "[dry] 删除目录 $DestDir"
        Say "[dry] 从用户 PATH 移除 $DestDir"
        Say "[dry] 从 $PROFILE 移除标记块"
        return
    }
    if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force; Say "已删除 $DestDir" }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -and $userPath -split ';' -contains $DestDir) {
        $new = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $DestDir }) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $new, 'User')
        Say '已从用户 PATH 移除'
    }

    if (Test-Path $PROFILE) {
        $c = Get-Content -Raw -Encoding UTF8 $PROFILE
        if ($c -match [regex]::Escape($Marker)) {
            $c = [regex]::Replace($c, "(?s)\r?\n?" + [regex]::Escape($Marker) + ".*?" + [regex]::Escape($MarkerEnd) + "\r?\n?", "`n")
            Set-Content -Path $PROFILE -Value $c -Encoding UTF8 -NoNewline
            Say "已从 $PROFILE 移除别名"
        }
    }
    Say '卸载完成。重开终端生效。'
    return
}

# ---------- 安装 ----------
Say "源目录   : $SrcDir"
Say "目标目录 : $DestDir"
Say "用户 PATH: $([Environment]::GetEnvironmentVariable('Path','User'))"
Say "Profile  : $PROFILE"

if ($DryRun) {
    Say '[dry] 将创建目录并复制 cc.ps1 / cc-run.ps1'
    Say "[dry] 将把 $DestDir 追加到用户 PATH"
    Say "[dry] 将在 $PROFILE 追加 cc 函数别名（带标记块，可回滚）"
    Say '完成预览。去掉 -DryRun 再跑一次。'
    return
}

# 1) 复制
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
foreach ($f in @('cc.ps1', 'cc-run.ps1')) {
    Copy-Item (Join-Path $SrcDir $f) (Join-Path $DestDir $f) -Force
    Say "已复制 $f"
}

# 2) PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if ($userPath -split ';' -contains $DestDir) {
    Say '用户 PATH 里已存在，跳过'
}
else {
    $new = if ($userPath.Trim()) { $userPath.TrimEnd(';') + ';' + $DestDir } else { $DestDir }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Say "已加入用户 PATH: $DestDir"
}

# 3) profile 别名
$profileDir = Split-Path $PROFILE -Parent
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }

$block = @"

$Marker
function cc { & "$DestDir\cc.ps1" @args }
$MarkerEnd

"@

$existing = if (Test-Path $PROFILE) { Get-Content -Raw -Encoding UTF8 $PROFILE } else { '' }
if ($existing -match [regex]::Escape($Marker)) {
    Say 'profile 里已有 cc 别名，跳过'
}
else {
    Add-Content -Path $PROFILE -Value $block -Encoding UTF8
    Say "已写入 $PROFILE"
}

Say ''
Say '装完了。做两件事让它生效：'
Say '  1. 重开一个终端（PATH 变更只对新进程生效）'
Say '  2. 如果提示禁止运行脚本: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'
Say ''
Say '验证: cc help'
