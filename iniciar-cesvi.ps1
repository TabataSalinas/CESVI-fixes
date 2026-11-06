# Inicia CESVI con tu modelo de Ollama y (opcional) un link público para compartir.
#
# Uso (desde la carpeta del proyecto):
#   .\iniciar-cesvi.ps1              -> compila si hace falta, arranca y crea un link público
#   .\iniciar-cesvi.ps1 -SoloLocal   -> sin link público (solo http://127.0.0.1:8787)
#   .\iniciar-cesvi.ps1 -Recompilar  -> fuerza `npm run build` (después de actualizar el código)
#
# O haz doble clic en iniciar-cesvi.bat.
param(
  [switch]$SoloLocal,
  [switch]$Recompilar,
  [string]$Modelo = "cesvi",
  [int]$Puerto = 8787
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$base = "http://127.0.0.1:$Puerto"

function Paso($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }
function Falla($texto) { Write-Host "`nERROR: $texto" -ForegroundColor Red; exit 1 }
function Existe($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# 1. Ollama y el modelo
Paso "Revisando Ollama"
if (-not (Existe "ollama")) { Falla "No encontré Ollama. Instálalo desde https://ollama.com/download y vuelve a ejecutar." }
try {
  $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 5
} catch {
  Falla "Ollama no responde. Abre la aplicación de Ollama (o ejecuta 'ollama serve' en otra ventana) y vuelve a intentar."
}
$nombres = @($tags.models | ForEach-Object { $_.name })
if (-not ($nombres | Where-Object { $_ -eq $Modelo -or $_ -like "$($Modelo):*" })) {
  if (-not (Test-Path ".\cesvi-q4_k_m.gguf")) {
    Falla "Ollama no tiene el modelo '$Modelo' y no encontré cesvi-q4_k_m.gguf en esta carpeta. Copia el archivo aquí (junto a Modelfile)."
  }
  Paso "Creando el modelo '$Modelo' en Ollama (solo la primera vez, tarda unos minutos)"
  & ollama create $Modelo -f Modelfile
  if ($LASTEXITCODE -ne 0) { Falla "ollama create falló." }
}

# 2. Python
Paso "Revisando Python"
$py = $null
if (Existe "py") { $py = @("py", "-3") } elseif (Existe "python") { $py = @("python") }
if (-not $py) { Falla "No encontré Python. Instálalo desde https://www.python.org/downloads/ (marca 'Add python.exe to PATH')." }

# 3. Compilar la web
if ($Recompilar -or -not (Test-Path ".\dist\index.html")) {
  if (-not (Existe "npm")) { Falla "No encontré npm. Instala Node.js 22 desde https://nodejs.org" }
  if (-not (Test-Path ".\node_modules")) {
    Paso "Instalando dependencias (npm install, solo la primera vez)"
    & npm install
    if ($LASTEXITCODE -ne 0) { Falla "npm install falló. Copia el error y revísalo." }
  }
  Paso "Compilando la web (npm run build)"
  & npm run build
  if ($LASTEXITCODE -ne 0) { Falla "npm run build falló. Copia el error y revísalo." }
}

# 4. Precargar el modelo (evita que la primera pregunta supere el límite del túnel)
Paso "Cargando el modelo en memoria (puede tardar 1-2 minutos la primera vez)"
try {
  $cuerpo = @{ model = $Modelo; keep_alive = "60m" } | ConvertTo-Json
  Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/generate" -Method Post -ContentType "application/json" -Body $cuerpo -TimeoutSec 600 | Out-Null
} catch {
  Write-Host "Aviso: no se pudo precargar el modelo ($($_.Exception.Message)). Se cargará con la primera pregunta." -ForegroundColor Yellow
}

# 5. Servidor de CESVI
Paso "Arrancando el servidor de CESVI en $base"
$env:CHATBOT_PORT = "$Puerto"
$env:OLLAMA_MODEL = $Modelo
$pyArgs = @()
if ($py.Count -gt 1) { $pyArgs += $py[1..($py.Count - 1)] }
$pyArgs += "chatbot-service\server.py"
$servidor = Start-Process -FilePath $py[0] -ArgumentList $pyArgs -PassThru -NoNewWindow
$listo = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try { Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 2 | Out-Null; $listo = $true; break } catch {}
  if ($servidor.HasExited) { break }
}
if (-not $listo) { Falla "El servidor no arrancó. Revisa los mensajes de arriba (¿el puerto $Puerto está ocupado?)." }

$tunel = $null
try {
  if ($SoloLocal) {
    Write-Host "`nCESVI está listo en: $base" -ForegroundColor Green
    Start-Process $base
  } elseif (-not (Existe "cloudflared")) {
    Write-Host "`nCESVI está listo en: $base" -ForegroundColor Green
    Write-Host "Para compartir un link público instala cloudflared y vuelve a ejecutar:" -ForegroundColor Yellow
    Write-Host "  winget install --id Cloudflare.cloudflared" -ForegroundColor Yellow
    Start-Process $base
  } else {
    Paso "Creando el link público con Cloudflare"
    $log = Join-Path $env:TEMP "cesvi-cloudflared.log"
    if (Test-Path $log) { Remove-Item $log -Force }
    $tunel = Start-Process -FilePath "cloudflared" -ArgumentList @("tunnel", "--no-autoupdate", "--url", $base, "--logfile", $log) -PassThru -WindowStyle Hidden
    $url = $null
    for ($i = 0; $i -lt 60 -and -not $url; $i++) {
      Start-Sleep -Seconds 1
      if (Test-Path $log) {
        # El log también menciona api.trycloudflare.com (uso interno): no es el link.
        $url = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches |
          ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } |
          Where-Object { $_ -ne "https://api.trycloudflare.com" } | Select-Object -First 1
      }
      if ($tunel.HasExited) { break }
    }
    if (-not $url) {
      Write-Host "No pude obtener el link público. Revisa $log. La app sigue disponible en $base" -ForegroundColor Yellow
    } else {
      try { Set-Clipboard -Value $url } catch {}
      Write-Host ""
      Write-Host "==============================================================" -ForegroundColor Green
      Write-Host " LINK PARA COMPARTIR (ya está copiado al portapapeles):" -ForegroundColor Green
      Write-Host " $url" -ForegroundColor Green
      Write-Host "==============================================================" -ForegroundColor Green
      Write-Host " Funciona mientras esta ventana siga abierta y la PC encendida."
      Write-Host " El link cambia cada vez que vuelves a ejecutar este script."
      Start-Process $url
    }
  }
  Write-Host "`nPara detener todo, cierra esta ventana o presiona Ctrl + C." -ForegroundColor Cyan
  Wait-Process -Id $servidor.Id
} finally {
  if ($tunel -and -not $tunel.HasExited) { Stop-Process -Id $tunel.Id -Force -ErrorAction SilentlyContinue }
  if ($servidor -and -not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force -ErrorAction SilentlyContinue }
}
