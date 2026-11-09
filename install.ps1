# Installs dsh-mermaid-boost into a dsh profile (default: web).
#
#   pwsh -File install.ps1                              # web profile, default paths
#   pwsh -File install.ps1 -ProfileName myprofile       # another profile
#
# What it does (idempotent, every config change gets a .bak-mermaid-boost backup):
#   1. copies the plugin package into <profile>\plugins\mermaid-boost\
#   2. vendors the mermaid library (scripts/prepare-mermaid.mjs; skipped when present)
#   3. adds plugins/* to <profile>\pnpm-workspace.yaml
#   4. adds the workspace dependency to <profile>\package.json
#   5. appends the loader entry (insert patch) to <profile>\cordis.patch.yml
#   6. links node_modules\dsh-mermaid-boost -> plugins\mermaid-boost (junction)
#      (the official alternative is: dsh plugin install --profile <name>)
#
# Afterwards restart dsh web; every ```mermaid code block in the GUI renders as a diagram.

param(
	[string]$ProfileName = "web",
	[string]$DshHome = (Join-Path $env:USERPROFILE ".dsh")
)

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$pluginDir = Join-Path $profileDir "plugins\mermaid-boost"

if (-not (Test-Path (Join-Path $profileDir "package.json"))) {
	throw "profile not found: $profileDir (run 'dsh' once to create it, or pass -ProfileName)"
}

function Backup-Once($path) {
	if (Test-Path $path) {
		$backup = "$path.bak-mermaid-boost"
		if (-not (Test-Path $backup)) { Copy-Item $path $backup -Force }
	}
}

# 1. plugin package files (lib/mermaid is generated, never overwritten here)
New-Item "$pluginDir\lib", "$pluginDir\scripts" -ItemType Directory -Force | Out-Null
Copy-Item "$repo\package.json" $pluginDir -Force
Copy-Item "$repo\lib\index.js", "$repo\lib\client.js" "$pluginDir\lib" -Force
if (Test-Path "$repo\scripts\prepare-mermaid.mjs") { Copy-Item "$repo\scripts\prepare-mermaid.mjs" "$pluginDir\scripts" -Force }

# 2. mermaid library
$entry = Join-Path $pluginDir "lib\mermaid\mermaid.esm.min.js"
if (Test-Path $entry) {
	Write-Host "[2/6] mermaid library already vendored."
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
	Write-Host "[2/6] vendoring mermaid library ..."
	Push-Location $pluginDir
	try { node scripts\prepare-mermaid.mjs } finally { Pop-Location }
} else {
	throw "node not found on PATH; install node or copy a prepared lib\mermaid folder manually"
}

# 3. pnpm workspace packages
$ws = Join-Path $profileDir "pnpm-workspace.yaml"
if (Test-Path $ws) {
	Backup-Once $ws
	$content = Get-Content $ws -Raw
	if ($content -notmatch 'plugins/\*') {
		if ($content -match '(?m)^packages:\s*$') {
			$content = $content -replace '(?m)^(packages:\s*\r?\n)', "`$1  - plugins/*`n"
			[System.IO.File]::WriteAllText($ws, $content)
			Write-Host "[3/6] pnpm-workspace.yaml: added plugins/* to packages."
		} else {
			Add-Content $ws "`npackages:`n  - plugins/*"
			Write-Host "[3/6] pnpm-workspace.yaml: appended packages block."
		}
	} else { Write-Host "[3/6] pnpm-workspace.yaml already lists plugins/*." }
}

# 4. profile dependency
$pkgPath = Join-Path $profileDir "package.json"
Backup-Once $pkgPath
$pkg = Get-Content $pkgPath -Raw
if ($pkg -notmatch '"dsh-mermaid-boost"') {
	$pkg = $pkg -replace '("dependencies"\s*:\s*\{)', "`$1`n    `"dsh-mermaid-boost`": `"workspace:*`","
	[System.IO.File]::WriteAllText($pkgPath, $pkg)
	Write-Host "[4/6] profile package.json: added dsh-mermaid-boost dependency."
} else { Write-Host "[4/6] profile package.json already references dsh-mermaid-boost." }

# 5. cordis patch entry
$patch = Join-Path $profileDir "cordis.patch.yml"
if (Test-Path $patch) {
	Backup-Once $patch
	$content = Get-Content $patch -Raw
	if ($content -notmatch 'dsh-mermaid-boost') {
		if (-not $content.EndsWith("`n")) { $content += "`n" }
		$block = @"

# mermaid-boost: render mermaid fenced code blocks as diagrams in the Web GUI
# (chat, Markdown preview, deliverables). Plugin package: plugins/mermaid-boost/.
- insert:
    - id: mermaid-boost
      name: dsh-mermaid-boost
"@
		[System.IO.File]::WriteAllText($patch, $content + $block)
		Write-Host "[5/6] cordis.patch.yml: appended the mermaid-boost insert entry."
	} else { Write-Host "[5/6] cordis.patch.yml already mounts dsh-mermaid-boost." }
} else {
	throw "cordis.patch.yml not found in $profileDir; create it or mount the plugin another way"
}

# 6. module link (official alternative: dsh plugin install --profile <name>)
$link = Join-Path $profileDir "node_modules\dsh-mermaid-boost"
if (Test-Path $link) {
	Write-Host "[6/6] node_modules\dsh-mermaid-boost link already present."
} else {
	New-Item (Join-Path $profileDir "node_modules") -ItemType Directory -Force | Out-Null
	New-Item -ItemType Junction -Path $link -Target $pluginDir | Out-Null
	Write-Host "[6/6] created junction node_modules\dsh-mermaid-boost -> plugins\mermaid-boost."
}

Write-Host ""
Write-Host "Done. Restart dsh web (close and run 'dsh web' again), then refresh the GUI."
