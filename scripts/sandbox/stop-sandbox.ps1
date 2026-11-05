# Stop any Code.exe instance that belongs to the sandbox profile.
# Separate .ps1 on purpose: the cmd wrapper would need ^| and \" escaping for the same
# one-liner, which is exactly the kind of thing that breaks silently -- we already lost
# time twice to cmd's quoting/codepage quirks in this folder.
$ErrorActionPreference = "SilentlyContinue"
$procs = Get-CimInstance Win32_Process -Filter "name='Code.exe'" |
  Where-Object { $_.CommandLine -like '*pi-vscode-sandbox*' }
if ($procs) {
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  "stopped {0} sandbox process(es)" -f @($procs).Count | Write-Output
} else {
  "no sandbox instance running" | Write-Output
}
