# Lists (and with 'kill', ends) Chromium browsers left over from test and experiment runs:
# ones whose profile is a temporary webtab-*/vis-* folder. Never touches your everyday browser.
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File orphans.ps1 [kill]
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'webtab-(engine|dbg|rec|mcp|install)|\\vis-' }
$main = $procs | Where-Object { $_.CommandLine -notmatch '--type=' }
Write-Output ("test-profile chrome processes: {0} (browsers: {1})" -f @($procs).Count, @($main).Count)
foreach ($m in $main) { Write-Output ("  pid {0} started {1}: {2}" -f $m.ProcessId, $m.CreationDate, ($m.CommandLine -replace '.*user-data-dir=([^ ]+).*','$1')) }
if ($args[0] -eq 'kill') { foreach ($m in $main) { & taskkill /PID $m.ProcessId /T /F | Out-Null }; Write-Output "killed" }
