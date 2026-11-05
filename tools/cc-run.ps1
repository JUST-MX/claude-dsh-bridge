<#
cc-run.ps1 —— 由 cc.ps1 拉起的"标签页里那一层"

作用：进到目标 worktree 目录 -> 设置标题 -> 前台跑 claude。
claude 退出后回到 PowerShell 提示符（因为外层带了 -NoExit），
方便直接 /resume 或者重开一个。

一般不用手动调用；想手动用就：
  powershell.exe -NoExit -File cc-run.ps1 -Path D:\repo-cc\my-feature
#>

[CmdletBinding()]
param(
    [string]$Path,
    [string]$Prompt
)

$ErrorActionPreference = 'Continue'

if ($Path -and (Test-Path -LiteralPath $Path)) {
    Set-Location -LiteralPath $Path
}

# 标签页标题：cc:<名字>
$leaf = Split-Path -Leaf (Get-Location).Path
$parentLeaf = Split-Path -Leaf (Split-Path -Parent (Get-Location).Path)
$label = if ($parentLeaf -and $parentLeaf -match '-cc$') { $leaf } else { $leaf }
try { $Host.UI.RawUI.WindowTitle = "cc:$label" } catch { }

Write-Host "cc:$label" -ForegroundColor Cyan -NoNewline
Write-Host "  →  $(Get-Location)" -ForegroundColor DarkGray
Write-Host '（claude 退出后本窗口保留；可以直接再敲 claude）' -ForegroundColor DarkGray
Write-Host ''

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host '[cc] 找不到 claude 命令，检查 PATH' -ForegroundColor Red
    return
}

if ($Prompt -and $Prompt.Trim()) {
    & claude $Prompt.Trim()
}
else {
    & claude
}
