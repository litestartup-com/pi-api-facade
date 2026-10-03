# Launch pi-api-facade for one node (Windows).
#
# Secrets come from the environment or a key file outside the repo; nothing is
# stored in the repository. Usage:
#
#   $env:DEEPSEEK_API_KEY = "..."
#   .\scripts\start-facade.ps1 -KeysFile C:\dac\pi01-key.txt -Port 3091
#
param(
  [string]$AgentDir = "",
  [int]$Port = 3091,
  [string]$KeysFile = "",
  [string]$Model = "deepseek/deepseek-flash",
  [string]$Engine = "sdk"
)
$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
if ($AgentDir -eq "") { $AgentDir = Join-Path $repo "data\agent" }
New-Item -ItemType Directory -Force $AgentDir | Out-Null

# Headless nodes cannot answer the project-trust prompt; without this setting
# Pi silently skips workspace .pi resources (SYSTEM.md, skills, extensions).
$settings = Join-Path $AgentDir "settings.json"
if (-not (Test-Path $settings)) {
  Set-Content -Path $settings -Value '{ "defaultProjectTrust": "always" }' -Encoding utf8
  Write-Host "created $settings (defaultProjectTrust: always)"
}

if ($KeysFile -ne "") {
  $env:PI_FACADE_API_KEYS = (Get-Content $KeysFile -Raw).Trim()
}
if (-not $env:PI_FACADE_API_KEYS) {
  throw "PI_FACADE_API_KEYS is required (env or -KeysFile); refusing to start fail-closed with no keys"
}

$env:PI_FACADE_ENGINE = $Engine
$env:PI_FACADE_MODEL = $Model
$env:PI_AGENT_DIR = (Resolve-Path $AgentDir).Path
$env:PI_FACADE_PORT = "$Port"
if (-not $env:PI_FACADE_HOST) { $env:PI_FACADE_HOST = "127.0.0.1" }

if ($Engine -eq "sdk" -and -not $env:DEEPSEEK_API_KEY) {
  Write-Warning "DEEPSEEK_API_KEY is not set — deepseek sessions will fail until a provider credential is available"
}

Push-Location $repo
try {
  node src/index.ts
} finally {
  Pop-Location
}
