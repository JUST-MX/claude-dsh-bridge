<#
cc.ps1 —— Claude Code 多会话管理（Windows / Windows PowerShell 5.1+）

三个层次：
  1) 一个任务一个 git worktree       —— 并发改代码不会互相踩；分支天然隔离
  2) 一个任务一个终端标签页           —— 标题固定为 cc:<名字>，一眼认得出
  3) 长任务丢后台 + 一屏看全部        —— claude --bg / claude agents / claude attach

用法：
  cc new  <名字> [-Prompt "..."]   新建 worktree 并在新标签页里跑 claude
  cc ls                            后台会话 + 本仓库 worktree 一览
  cc at   <名字|id>                attach 进某个后台会话
  cc log  <名字|id>                打印后台会话最近的输出
  cc stop <名字|id>                停止后台会话（对话保留，随时可再 attach）
  cc bg   "任务描述"               丢一个 headless 任务到后台，命令立刻返回
  cc done <名字>                   删除后台会话 + 清掉 worktree
  cc cd   <名字>                   cd 进该任务的 worktree
  cc help                          帮助

选项：
  -NoTab    不新开窗口，直接在当前终端跑（在 tmux/psmux 里就用这个）
  -Window   强制用独立控制台窗口（默认优先 Windows Terminal 标签页）
  -DryRun   只打印将要执行的命令
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Action = 'ls',
    [Parameter(Position = 1)][string]$Name,
    [Parameter(Position = 2)][string]$Prompt,
    [switch]$NoTab,
    [switch]$Window,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

# worktree 落地目录。默认和主仓库同级：<仓库父目录>\<仓库名>-cc\<名字>
# 想集中管理就设环境变量：CC_HOME=D:\cc-worktrees
$CC_WORKTREES = if ($env:CC_HOME) { $env:CC_HOME } else { $null }

function Write-Step($msg) { Write-Host "[cc] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[cc] $msg" -ForegroundColor Yellow }
function Write-Dim($msg)  { Write-Host "     $msg" -ForegroundColor DarkGray }
function Fail($msg) { Write-Host "[cc] $msg" -ForegroundColor Red; exit 1 }

function Get-RepoRoot {
    $out = & git rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    return ((@($out)[0]) -replace '/', '\')
}

function Invoke-Git {
    param([string[]]$GitArgs)
    $out = & git @GitArgs 2>&1
    return @{ Code = $LASTEXITCODE; Text = (($out | ForEach-Object { "$_" }) -join "`n") }
}

function Get-WtRoot {
    param([string]$RepoRoot)
    if ($CC_WORKTREES) { return $CC_WORKTREES }
    $repoName = Split-Path $RepoRoot -Leaf
    return (Join-Path (Split-Path $RepoRoot -Parent) "$repoName-cc")
}

$HelpText = @'
cc —— Claude Code 多会话管理

  cc new  <名字> [-Prompt "..."]   新建 worktree + 新标签页跑 claude
  cc ls                            后台会话 + 本仓库 worktree 一览
  cc at   <名字|id>                attach 进后台会话   (← 回到列表 / Ctrl+Z 回 shell)
  cc log  <名字|id>                看后台会话输出
  cc stop <名字|id>                停止（对话保留）
  cc bg   "任务描述"               后台 headless 任务
  cc done <名字>                   清掉后台会话 + worktree
  cc cd   <名字>                   cd 进该任务的 worktree

  选项: -NoTab  在当前终端跑（tmux/psmux）
        -Window 强制独立控制台窗口
        -DryRun 只打印不执行

  Claude 自带: claude agents     全屏会话列表，回车 attach
              claude --bg "…" 起后台会话，起它的窗口可以直接关掉
'@

function Show-Help {
    Write-Host $HelpText -ForegroundColor Gray
}

# 在新标签页 / 新窗口里启动 claude
function Start-ClaudeWindow {
    param(
        [string]$Title,
        [string]$WorkDir,
        [string]$ClaudePrompt,
        [switch]$ForceWindow
    )

    $runner = Join-Path $PSScriptRoot 'cc-run.ps1'
    if (-not (Test-Path $runner)) { $runner = $null }

    $useWt = (-not $ForceWindow) -and [bool](Get-Command wt -ErrorAction SilentlyContinue)

    if ($useWt) {
        if ($runner) {
            $wtArgs = @('-w', '0', 'new-tab', '--title', $Title, '-d', $WorkDir,
                        'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass',
                        '-File', $runner, '-Path', $WorkDir)
            if ($ClaudePrompt -and $ClaudePrompt.Trim()) { $wtArgs += @('-Prompt', $ClaudePrompt.Trim()) }
        }
        else {
            $wtArgs = @('-w', '0', 'new-tab', '--title', $Title, '-d', $WorkDir, 'claude')
        }

        if ($DryRun) { Write-Step ("将要执行: wt " + ($wtArgs -join ' ')); return }

        & wt @wtArgs 2>$null
        if ($LASTEXITCODE -eq 0) { return }
        Write-Warn "wt 启动失败（$LASTEXITCODE），改用独立窗口"
    }

    # 回退：独立控制台窗口
    $argList = @('-NoExit', '-ExecutionPolicy', 'Bypass')
    if ($runner) {
        $argList += @('-File', "`"$runner`"", '-Path', "`"$WorkDir`"")
        if ($ClaudePrompt -and $ClaudePrompt.Trim()) { $argList += @('-Prompt', "`"$($ClaudePrompt.Trim())`"") }
    }
    else {
        $argList += @('-Command', "Set-Location -LiteralPath '$WorkDir'; claude")
    }

    if ($DryRun) {
        Write-Step "将要执行: Start-Process powershell.exe $($argList -join ' ') -WorkingDirectory `"$WorkDir`""
        return
    }

    Start-Process powershell.exe -ArgumentList $argList -WorkingDirectory $WorkDir
}

switch ($Action.ToLower()) {

    'help' { Show-Help }

    'new' {
        if (-not $Name) { Fail '用法: cc new <名字> [-Prompt "初始任务"]' }

        $repo = Get-RepoRoot
        if (-not $repo) { Fail '当前目录不在 git 仓库里 —— worktree 模式需要 git 仓库。' }

        $wtRoot = Get-WtRoot -RepoRoot $repo
        $wtPath = Join-Path $wtRoot $Name
        $branch = "cc/$Name"

        if (Test-Path $wtPath) {
            Write-Warn "worktree 已存在，直接复用: $wtPath"
        }
        else {
            $parent = Split-Path $wtPath -Parent
            if (-not (Test-Path $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }

            $probe = Invoke-Git @('rev-parse', '--verify', '--quiet', "refs/heads/$branch")
            if ($probe.Code -eq 0) {
                Write-Step "复用已有分支 $branch"
                $r = Invoke-Git @('worktree', 'add', $wtPath, $branch)
            }
            else {
                Write-Step "新建分支 $branch"
                $r = Invoke-Git @('worktree', 'add', '-b', $branch, $wtPath)
            }
            if ($r.Code -ne 0) { Fail "git worktree 创建失败:`n$($r.Text)" }
            Write-Step "worktree -> $wtPath"
        }

        if ($NoTab) {
            if ($DryRun) { Write-Step "将要执行: cd `"$wtPath`"; claude $Prompt"; break }
            Set-Location $wtPath
            $a = @()
            if ($Prompt -and $Prompt.Trim()) { $a += $Prompt.Trim() }
            & claude @a
            break
        }

        Start-ClaudeWindow -Title "cc:$Name" -WorkDir $wtPath -ClaudePrompt $Prompt -ForceWindow:$Window
        if (-not $DryRun) { Write-Step "已启动 cc:$Name   （cc ls 看全部，claude agents 看后台会话）" }
    }

    'ls' {
        $repo = Get-RepoRoot

        $raw = ((& claude agents --json 2>$null) | ForEach-Object { "$_" }) -join "`n"
        Write-Host ''
        Write-Host '== 后台会话 (claude --bg) ==' -ForegroundColor Green

        if (-not $raw.Trim() -or $raw.Trim() -eq '[]') {
            Write-Host '  （没有后台会话。用 cc bg "任务" 起一个）' -ForegroundColor DarkGray
        }
        else {
            try {
                $items = $raw | ConvertFrom-Json
                $rows = foreach ($it in @($items)) {
                    $o = [ordered]@{}
                    foreach ($prop in $it.PSObject.Properties) {
                        $v = $prop.Value
                        if ($null -eq $v) { continue }
                        if ($v -is [string] -or $v -is [bool] -or $v -is [int] -or
                            $v -is [long] -or $v -is [double] -or $v -is [datetime]) {
                            $o[$prop.Name] = $v
                        }
                    }
                    [pscustomobject]$o
                }
                $txt = ($rows | Format-Table -AutoSize | Out-String -Width 200)
                Write-Host $txt.TrimEnd()
            }
            catch {
                Write-Warn "解析 agents --json 失败：$($_.Exception.Message)"
                Write-Host $raw
            }
        }

        if ($repo) {
            $wt = Invoke-Git @('worktree', 'list')
            Write-Host ''
            Write-Host "== 本仓库 worktree ==" -ForegroundColor Green
            Write-Dim $repo
            Write-Host ($wt.Text)
            Write-Host '  删除某个: cc done <名字>；清理失效记录: git worktree prune' -ForegroundColor DarkGray
        }
    }

    'at'    { if (-not $Name) { Fail '用法: cc at <名字|id>' };   & claude attach $Name }
    'log'   { if (-not $Name) { Fail '用法: cc log <名字|id>' };  & claude logs $Name }
    'stop'  { if (-not $Name) { Fail '用法: cc stop <名字|id>' }; & claude stop $Name }
    'agents' { $extra = @(); if ($Name) { $extra = @($Name) }; & claude agents @extra }

    'cd' {
        if (-not $Name) { Fail '用法: cc cd <名字>' }
        $repo = Get-RepoRoot
        if (-not $repo) { Fail '当前目录不在 git 仓库里。' }
        $wtPath = Join-Path (Get-WtRoot -RepoRoot $repo) $Name
        if (-not (Test-Path $wtPath)) { Fail "没有这个 worktree: $wtPath" }
        Set-Location $wtPath
        Write-Step "cd $wtPath"
    }

    'bg' {
        if (-not $Name) { Fail '用法: cc bg "任务描述"' }
        if ($DryRun) { Write-Step "将要执行: claude --bg `"$Name`""; break }

        $out = ((& claude --bg $Name 2>&1) | ForEach-Object { "$_" }) -join "`n"
        if ($out.Trim()) { Write-Host $out }

        if ($LASTEXITCODE -ne 0) {
            Write-Warn '后台会话没起来。常见原因：'
            Write-Warn '  1) 这个目录还没 trust 过 —— 先在当前目录手动跑一次 claude，按回车信任'
            Write-Warn '  2) %USERPROFILE%\.claude\jobs 建不出来（权限/杀软）'
        }
        else {
            Write-Step '已丢到后台，起它的命令窗口可以关掉。cc ls 查看，cc at <名字> 接回去'
        }
    }

    'done' {
        if (-not $Name) { Fail '用法: cc done <名字>' }
        $repo = Get-RepoRoot
        $wtPath = if ($repo) { Join-Path (Get-WtRoot -RepoRoot $repo) $Name } else { $null }

        if ($DryRun) {
            Write-Step "将要执行: claude rm $Name（若存在）"
            if ($wtPath) { Write-Step "将要执行: git worktree remove `"$wtPath`"" }
            break
        }

        $null = & claude rm $Name 2>&1

        if ($wtPath -and (Test-Path $wtPath)) {
            $r = Invoke-Git @('worktree', 'remove', $wtPath)
            if ($r.Code -ne 0) {
                Write-Warn 'worktree 没删掉（可能有未提交改动）:'
                Write-Dim $r.Text
                Write-Dim "确认不要了就手动: git worktree remove --force `"$wtPath`""
            }
            else { Write-Step "已删除 worktree: $wtPath（分支 cc/$Name 保留）" }
        }
        else {
            Write-Step "已处理 $Name"
        }
    }

    default {
        Write-Warn "未知命令: $Action"
        Show-Help
    }
}
