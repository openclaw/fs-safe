$ErrorActionPreference = 'Stop'
$workspace = (Get-Location).Path
$toolsDir = Join-Path $env:USERPROFILE 'fs-safe-race-tools'
New-Item -ItemType Directory -Force $toolsDir | Out-Null
$checksums = Invoke-RestMethod https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
$line = @($checksums -split "`n" | Where-Object { $_ -match 'node-v24\.[\d.]+-win-x64.zip$' })[0]
$parts = $line.Trim() -split '\s+'
$zip = Join-Path $toolsDir $parts[1]
Invoke-WebRequest ('https://nodejs.org/dist/latest-v24.x/' + $parts[1]) -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $parts[0]) { throw 'Node checksum mismatch' }
Expand-Archive -Force $zip $toolsDir
$nodeDir = Join-Path $toolsDir ([IO.Path]::GetFileNameWithoutExtension($parts[1]))
$env:PATH = "$nodeDir;$toolsDir;$env:PATH"
& npm.cmd install --global pnpm@12.4.2 --prefix $toolsDir
if ($LASTEXITCODE) { throw 'pnpm install failed' }
& node --version
& pnpm.cmd --version
& pnpm.cmd install --frozen-lockfile
if ($LASTEXITCODE) { throw 'dependency install failed' }
# This proof changes no Rust. Compile current-main JS and use the approved published binding.
& pnpm.cmd exec tsc -p tsconfig.json
if ($LASTEXITCODE) { throw 'TypeScript compile failed' }
@'
import { copyWindowsCommandAssets } from "../../scripts/windows-command-assets.mjs";
copyWindowsCommandAssets();
'@ | Set-Content -Encoding UTF8 scripts/root-race/copy-assets.mjs
& node scripts/root-race/copy-assets.mjs
if ($LASTEXITCODE) { throw 'Windows assets copy failed' }
New-Item -ItemType Directory -Force '.artifacts/native' | Out-Null
Push-Location '.artifacts/native'
& npm.cmd pack @openclaw/fs-safe-win32-x64-msvc@0.21.0 --ignore-scripts
if ($LASTEXITCODE) { throw 'binding fetch failed' }
& tar -xzf openclaw-fs-safe-win32-x64-msvc-0.21.0.tgz
Copy-Item -Force package/fs-safe-native.node (Join-Path $workspace 'packages/win32-x64-msvc/fs-safe-native.node')
Pop-Location
& node scripts/root-race/run.mjs --seeds=6 --seconds=2 --output=.artifacts/windows-smoke.jsonl
if ($LASTEXITCODE) { throw 'smoke failed' }
& node scripts/root-race/run.mjs --seeds=60 --seconds=20 --output=.artifacts/windows-races.jsonl
if ($LASTEXITCODE) { throw 'race campaign failed' }
