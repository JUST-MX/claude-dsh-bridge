# What must happen before the running Harness picks up the current files?
#
# Three artifacts reload by three different mechanisms, and using the wrong one
# produces a confusing partial update rather than an error:
#
#   index.js          Host code. `plugin_manager set_plugin` enable/disable DOES
#                     re-import it, so a new tool description or a changed method
#                     body appears without restarting.
#   client.js         Panel code. A page refresh is enough (client-hmr polls the
#                     bundle's mtime anyway).
#   typert.js         The wire surface, imported once by typert-loader and cached
#   remote.js         per package name with no invalidation path. Its source header
#                     says so verbatim:
#                       "Package verdicts and imported manifests are cached per
#                        package name and never expire - plugin-set changes take
#                        effect on restart."
#                     Adding or renaming a Remote method therefore looks fine right
#                     up until that one method is called:
#                       client api: claudeSessions/answer failed:
#                       transport failure for /api/claudeSessions/answer: HTTP 404
#                     The gateway README explains the 404: the Host interceptor
#                     "returns 404 for unclaimed requests", and the endpoint is
#                     unclaimed because the manifest registered at startup predates
#                     it.
#
# The check compares each artifact's mtime against the running process's start time:
# anything written after the process started is, for that process, whatever it
# imported at startup.
#
# NOTE: this file is deliberately pure ASCII. PowerShell 5.1 reads a .ps1 without
# a BOM as ANSI, which turns an em dash into mojibake on output.
#
# Run: powershell -NoProfile -File tools/check-manifest-stale.ps1

$ErrorActionPreference = 'Stop'

$pkg = Join-Path $PSScriptRoot '..\plugin\packages\claude-sessions'

$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime } |
    Sort-Object StartTime

if (-not $procs) {
    Write-Host 'check-manifest-stale: DeepSeek Harness is not running; nothing to compare'
    exit 0
}

# The OLDEST process is the authority: every one of them had to have imported the
# manifest before any of them could serve a request.
$started = ($procs | Select-Object -First 1).StartTime

Write-Host ("check-manifest-stale: Harness started {0:yyyy-MM-dd HH:mm:ss} ({1} process(es))" -f $started, $procs.Count)

# Each artifact with the action its staleness requires.
$stale = @()
$check = {
    param($Name, $Action)
    $file = Join-Path $pkg $Name
    if (-not (Test-Path $file)) { return }
    $at = (Get-Item $file).LastWriteTime
    $newer = $at -gt $started
    $mark = if ($newer) { 'STALE' } else { 'ok   ' }
    Write-Host ("  {0} {1,-12} {2:yyyy-MM-dd HH:mm:ss}" -f $mark, $Name, $at)
    if ($newer) { $script:stale += ,@($Name, $Action) }
}

& $check 'typert.js' 'quit DeepSeek Harness completely and reopen it'
& $check 'remote.js' 'quit DeepSeek Harness completely and reopen it'
& $check 'index.js'  'plugin_manager set_plugin enabled=false then true'
& $check 'client.js' 'refresh the page (client-hmr may already have done it)'

Write-Host ''

if ($script:stale.Count -eq 0) {
    Write-Host 'check-manifest-stale: the running Harness is at least as new as every artifact - OK'
    exit 0
}

# Report the strictest required action, because that is the one that unblocks
# everything: a restart also covers the Host and Client cases.
$restart = $script:stale | Where-Object { $_[1] -like 'quit*' }
Write-Host ("{0} artifact(s) changed after this process started:" -f $script:stale.Count)
foreach ($entry in $script:stale) {
    Write-Host ("  {0}: {1}" -f $entry[0], $entry[1])
}
Write-Host ''

if ($restart.Count -gt 0) {
    Write-Host 'REQUIRED: quit DeepSeek Harness completely and reopen it.'
    Write-Host '  Do NOT rely on the set_plugin round trip here: typert-loader caches the'
    Write-Host '  imported manifest per package name and never expires it, so the new method'
    Write-Host '  will keep answering HTTP 404 until the process restarts.'
    exit 1
}

Write-Host 'No restart needed: the plugin round trip (and a page refresh) are enough.'
exit 0
