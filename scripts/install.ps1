param(
  [switch]$SkipUiPatch,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-CheckedStep {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Write-Host "`n==> $Label" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed ($Label) with exit code $LASTEXITCODE."
  }
}

function Resolve-CodeCli {
  $cmd = Get-Command 'code' -ErrorAction SilentlyContinue
  if ($null -ne $cmd) {
    return $cmd.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw "Could not find 'code' CLI on PATH or in standard VS Code installation folders."
}

Push-Location $repoRoot
try {
  if (-not $SkipTests) {
    Invoke-CheckedStep -Label 'Running unit tests' -Action {
      npm run test:unit
    }
  } else {
    Write-Host "`n==> Skipping unit tests (-SkipTests)" -ForegroundColor Yellow
  }

  Invoke-CheckedStep -Label 'Building extension bundle' -Action {
    npm run build
  }

  Invoke-CheckedStep -Label 'Packaging VSIX' -Action {
    npm run package:vsix
  }

  $vsix = Get-ChildItem -LiteralPath $repoRoot -Filter '*.vsix' |
    Sort-Object -Property LastWriteTime -Descending |
    Select-Object -First 1

  if ($null -eq $vsix) {
    throw "No .vsix package found in $repoRoot after vsce package."
  }
  Write-Host "Packaged VSIX: $($vsix.FullName)" -ForegroundColor Green

  Invoke-CheckedStep -Label 'Patching ~/.vscode/argv.json (enable-proposed-api)' -Action {
    node scripts/patch-argv.js
  }

  if (-not $SkipUiPatch) {
    Write-Host "`n==> Patching VS Code Sessions/Workbench account & quota UI" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    node scripts/patch-sessions-ui.js --apply
    if ($LASTEXITCODE -ne 0) {
      throw "UI patch failed with exit code $LASTEXITCODE. See the [patch-sessions-ui] message above for the cause. Run 'node scripts/patch-sessions-ui.js --check' to inspect compatibility, or retry with -SkipUiPatch to install without the UI patch."
    }
  } else {
    Write-Host "`n==> Skipping VS Code UI patch (-SkipUiPatch)" -ForegroundColor Yellow
  }

  $codeCli = Resolve-CodeCli
  Invoke-CheckedStep -Label "Installing VSIX into VS Code ($($vsix.Name))" -Action {
    & $codeCli --install-extension $vsix.FullName --force
  }

  Invoke-CheckedStep -Label 'Syncing extension across all VS Code profiles' -Action {
    $syncScript = @'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const extId = "antigravity.agy-copilot-harness";
const defaultExtPath = path.join(os.homedir(), ".vscode", "extensions", "extensions.json");
if (!fs.existsSync(defaultExtPath)) {
  throw new Error(`Missing default extensions manifest: ${defaultExtPath}`);
}

const defaultList = JSON.parse(fs.readFileSync(defaultExtPath, "utf8"));
const baseEntry = defaultList.find((item) => item?.identifier?.id?.toLowerCase() === extId);
if (!baseEntry) {
  throw new Error(`Installed extension entry '${extId}' not found in ${defaultExtPath}`);
}

baseEntry.metadata = { ...(baseEntry.metadata || {}), isApplicationScoped: true };
fs.writeFileSync(defaultExtPath, JSON.stringify(defaultList, null, 2) + "\n", "utf8");
console.log(`[sync-profiles] Updated default extensions.json (${extId}, isApplicationScoped=true)`);

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const profilesRoot = path.join(appData, "Code", "User", "profiles");
if (fs.existsSync(profilesRoot)) {
  for (const dirent of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const profileExtPath = path.join(profilesRoot, dirent.name, "extensions.json");
    if (!fs.existsSync(profileExtPath)) continue;

    const list = JSON.parse(fs.readFileSync(profileExtPath, "utf8"));
    const cloned = JSON.parse(JSON.stringify(baseEntry));
    const idx = list.findIndex((item) => item?.identifier?.id?.toLowerCase() === extId);
    if (idx >= 0) {
      list[idx] = cloned;
    } else {
      list.push(cloned);
    }
    fs.writeFileSync(profileExtPath, JSON.stringify(list, null, 2) + "\n", "utf8");
    console.log(`[sync-profiles] Synced ${extId} to profile ${dirent.name}`);
  }
}
'@
    $syncScript | node
  }

  Write-Host "`nInstallation complete!" -ForegroundColor Green
  Write-Host "Restart VS Code (if already running) so argv.json and UI changes take effect." -ForegroundColor Gray
} finally {
  Pop-Location
}
