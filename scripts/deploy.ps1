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

foreach ($command in @('pnpm', 'tar.exe', 'scp.exe', 'ssh.exe')) {
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
  $tarArguments = @(
    '-czf', $archive,
    '--exclude=.git',
    '--exclude=node_modules',
    '--exclude=dist',
    '--exclude=.env',
    '--exclude=.env.production',
    '--exclude=backups',
    '--exclude=clirace-deploy.tar.gz',
    '.'
  )
  & tar.exe @tarArguments
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
