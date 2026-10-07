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
& npm.cmd install --global pnpm@12.10.1 --prefix $toolsDir
if ($LASTEXITCODE) { throw 'pnpm install failed' }
& node --version
& pnpm.cmd --version
& pnpm.cmd install --frozen-lockfile
if ($LASTEXITCODE) { throw 'dependency install failed' }
& pnpm.cmd build
if ($LASTEXITCODE) { throw 'source build failed; install the documented Rust/WASM toolchain' }
& pnpm.cmd native:build
if ($LASTEXITCODE) { throw 'matching native source build failed; install the documented MSVC toolchain' }
& node scripts/root-race/run.mjs --seeds=6 --seconds=2 --output=.artifacts/windows-smoke.jsonl
if ($LASTEXITCODE) { throw 'smoke failed' }
& node scripts/root-race/run.mjs --seeds=60 --seconds=20 --output=.artifacts/windows-races.jsonl
if ($LASTEXITCODE) { throw 'race campaign failed' }
