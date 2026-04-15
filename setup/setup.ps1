# setup.ps1 — Atlax360 Claude Code → Langfuse hook installer (Windows)
# Uso: .\setup.ps1 [-Host <url>] [-PublicKey <pk-lf-...>] [-SecretKey <sk-lf-...>]
# Requiere PowerShell 5.1+ o PowerShell Core 7+

param(
    [string]$LangfuseHost = "",
    [string]$PublicKey = "",
    [string]$SecretKey = ""
)

$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────────────────────
# Windows nativo: Claude Code guarda en %APPDATA%\Claude
$ClaudeDir    = Join-Path $env:APPDATA "Claude"
$HookDir      = Join-Path $ClaudeDir "hooks"
$HookScript   = Join-Path $HookDir "langfuse-sync.ts"
$SettingsFile = Join-Path $ClaudeDir "settings.json"
$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$HookSource   = Join-Path $ScriptDir "..\hooks\langfuse-sync.ts"

function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [X]  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  Atlax360 — Claude Code → Langfuse Setup (Windows)" -ForegroundColor Cyan
Write-Host "  ──────────────────────────────────────────────────" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check Bun ──────────────────────────────────────────────────────────────
try {
    $bunVersion = & bun --version 2>&1
    Write-Ok "Bun $bunVersion encontrado"
} catch {
    Write-Err "Bun no encontrado. Instala desde https://bun.sh"
    exit 1
}

# ── 2. Check Claude Code ──────────────────────────────────────────────────────
if (-not (Test-Path $ClaudeDir)) {
    Write-Err "$ClaudeDir no existe. ¿Claude Code está instalado?"
    exit 1
}
Write-Ok "Directorio Claude encontrado: $ClaudeDir"

# ── 3. Install hook script ─────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $HookDir | Out-Null

if (Test-Path $HookSource) {
    Copy-Item -Force $HookSource $HookScript
    Write-Ok "Hook instalado en $HookScript"
} else {
    Write-Warn "Fuente local no encontrada. Descargando desde repo..."
    Invoke-WebRequest `
        -Uri "https://raw.githubusercontent.com/Atlax-360-Test-IA/atlax-langfuse-bridge/main/hooks/langfuse-sync.ts" `
        -OutFile $HookScript
    Write-Ok "Hook descargado en $HookScript"
}

# ── 4. Update Claude Code settings.json ───────────────────────────────────────
if (-not (Test-Path $SettingsFile)) {
    Set-Content -Path $SettingsFile -Value "{}"
}

$settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json

# PowerShell PSCustomObject merge helper
if (-not $settings.hooks) {
    $settings | Add-Member -NotePropertyName "hooks" -NotePropertyValue ([PSCustomObject]@{}) -Force
}

$hookCmd = "bun run `"$HookScript`""
$newHook = [PSCustomObject]@{
    hooks = @(
        [PSCustomObject]@{
            type    = "command"
            command = $hookCmd
            timeout = 10000
        }
    )
}

$stopHooks = @()
if ($settings.hooks.Stop) {
    $stopHooks = @($settings.hooks.Stop)
}

# Check for duplicates
$alreadyPresent = $stopHooks | Where-Object {
    $_.hooks | Where-Object { $_.command -like "*langfuse-sync.ts*" }
}

if (-not $alreadyPresent) {
    $stopHooks += $newHook
    $settings.hooks | Add-Member -NotePropertyName "Stop" -NotePropertyValue $stopHooks -Force
    $settings | ConvertTo-Json -Depth 10 | Set-Content -Path $SettingsFile -Encoding UTF8
    Write-Ok "Hook Stop añadido a settings.json"
} else {
    Write-Ok "Hook Stop ya presente — sin cambios"
}

# ── 5. Set user environment variables (permanente via registry) ───────────────
if ($LangfuseHost -and $PublicKey -and $SecretKey) {
    [System.Environment]::SetEnvironmentVariable("LANGFUSE_HOST",       $LangfuseHost, "User")
    [System.Environment]::SetEnvironmentVariable("LANGFUSE_PUBLIC_KEY", $PublicKey,    "User")
    [System.Environment]::SetEnvironmentVariable("LANGFUSE_SECRET_KEY", $SecretKey,    "User")
    Write-Ok "Variables de entorno LANGFUSE_* configuradas para el usuario (permanente)"
    Write-Warn "Reinicia el terminal para que surtan efecto"
} else {
    Write-Warn "No se proporcionaron credenciales. Configura manualmente:"
    Write-Host ""
    Write-Host '  [System.Environment]::SetEnvironmentVariable("LANGFUSE_HOST",       "https://tu-instancia", "User")'
    Write-Host '  [System.Environment]::SetEnvironmentVariable("LANGFUSE_PUBLIC_KEY", "pk-lf-...", "User")'
    Write-Host '  [System.Environment]::SetEnvironmentVariable("LANGFUSE_SECRET_KEY", "sk-lf-...", "User")'
    Write-Host ""
}

# ── 6. Test ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Verificando script..."
try {
    $result = '{}' | & bun run $HookScript 2>&1
    Write-Ok "Script ejecuta sin errores"
} catch {
    Write-Warn "Script salió con error — revisa credenciales. $_"
}

Write-Host ""
Write-Ok "Setup completado. El hook se activará al final de cada sesión de Claude Code."
Write-Host ""
