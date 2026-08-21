[CmdletBinding()]
param(
  [string]$HostName = '172.24.24.203',
  [int]$Port = 6222,
  [string]$RemoteUser = 'codex',
  [string]$KeyPath = "$env:USERPROFILE\.ssh\clirace_deploy_ed25519"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $projectRoot 'clirace-deploy.tar.gz'
$runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
$runtimeFallback = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback'

if (Test-Path $runtimeNode) {
  $env:PATH = "$runtimeNode;$runtimeFallback;$env:PATH"
}

foreach ($command in @('pnpm', 'git.exe', 'scp.exe', 'ssh.exe')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required command was not found: $command"
  }
}

if (-not (Test-Path $KeyPath)) {
  throw "SSH key was not found: $KeyPath"
}

Push-Location $projectRoot
try {
  Write-Host '[1/4] Running the production build...' -ForegroundColor Cyan
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'The production build failed.' }

  Write-Host '[2/4] Creating the deployment archive...' -ForegroundColor Cyan
  & git.exe diff --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Commit local changes before deployment.' }
  & git.exe diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Commit staged changes before deployment.' }

  # Archive Git blobs instead of the Windows working tree. This preserves the
  # repository's LF rules and makes the deployed files byte-identical to HEAD.
  & git.exe -c core.autocrlf=false archive --format=tar.gz --output=$archive HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the deployment archive.' }

  Write-Host '[3/4] Uploading files to the server...' -ForegroundColor Cyan
  & scp.exe -q -i $KeyPath -P $Port $archive "${RemoteUser}@${HostName}:/tmp/clirace-deploy.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Unable to upload the archive.' }

  Write-Host '[4/4] Updating CLIRace and checking service health...' -ForegroundColor Cyan
  & ssh.exe -t -o BatchMode=yes -i $KeyPath -p $Port "${RemoteUser}@${HostName}" 'sudo -n /usr/local/sbin/clirace-deploy'
  if ($LASTEXITCODE -ne 0) { throw 'The server deployment failed.' }

  $hash = (Get-FileHash -Algorithm SHA256 $archive).Hash
  Write-Host "CLIRace was updated successfully. SHA-256: $hash" -ForegroundColor Green
}
finally {
  Pop-Location
}
