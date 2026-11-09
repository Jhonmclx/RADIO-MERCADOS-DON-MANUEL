# RADIO MERCADO DON MANUEL - instalacion en un PC con Windows 10/11 (servidor propio del almacen)
#
# Uso: abrir PowerShell COMO ADMINISTRADOR y pegar:
#   irm https://raw.githubusercontent.com/Jhonmclx/RADIO-MERCADOS-DON-MANUEL/main/deploy/windows/instalar.ps1 -OutFile $env:TEMP\instalar-radio.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\instalar-radio.ps1
#
# Que hace:
#  1. Instala Node.js 22 y FFmpeg (si faltan) dentro de C:\RadioDonManuel, sin tocar los programas del almacen.
#  2. Descarga la radio desde GitHub.
#  3. La primera vez trae la musica, los comerciales y la configuracion desde Supabase (modo "solo-migrar":
#     despues NO sube nada a Supabase; todo queda en el disco de este PC, sin limite de 1 GB).
#  4. La deja arrancando sola al encender el PC, en segundo plano y con prioridad baja (no frena el resto del PC).
#  5. Instala Tailscale y publica la radio con un link https para que la abran los TV de las cinco sedes.
#
# Volver a ejecutarlo = actualizar a la ultima version (la musica y los datos se conservan).

param([switch]$SinTailscale)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Paso($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "    $t" -ForegroundColor Yellow }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Abra PowerShell como ADMINISTRADOR (clic derecho > Ejecutar como administrador) y vuelva a pegar el comando." -ForegroundColor Red; exit 1 }

$Base = 'C:\RadioDonManuel'
$App = Join-Path $Base 'app'
$Datos = Join-Path $Base 'datos'
$Tools = Join-Path $Base 'herramientas'
$EnvGuardado = Join-Path $Base 'radio.env'
New-Item -ItemType Directory -Force -Path $Base, $Datos, $Tools | Out-Null

# ---------------------------------------------------------------- 1. Node.js
Paso "Revisando Node.js..."
$node = $null
$cands = @((Join-Path $Tools 'node\node.exe'), 'C:\Program Files\nodejs\node.exe')
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $cands += $cmd.Source }
foreach ($c in $cands) {
  if ($c -and (Test-Path $c)) {
    $v = (& $c -v) -replace '^v', ''
    $p = $v.Split('.')
    if ([int]$p[0] -gt 22 -or ([int]$p[0] -eq 22 -and [int]$p[1] -ge 13)) { $node = $c; break }
  }
}
if (-not $node) {
  Paso "Descargando Node.js 22 (portable, solo para la radio)..."
  $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $ver = ($idx | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
  $zip = Join-Path $env:TEMP "node-$ver.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP "node-$ver"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp -Force
  if (Test-Path (Join-Path $Tools 'node')) { Remove-Item (Join-Path $Tools 'node') -Recurse -Force }
  Move-Item (Join-Path $tmp "node-$ver-win-x64") (Join-Path $Tools 'node')
  $node = Join-Path $Tools 'node\node.exe'
}
Write-Host "    Node: $node ($(& $node -v))"

# ---------------------------------------------------------------- 2. FFmpeg
Paso "Revisando FFmpeg..."
$ffmpeg = Get-ChildItem -Path (Join-Path $Tools 'ffmpeg') -Filter ffmpeg.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ffmpeg) {
  Paso "Descargando FFmpeg (unos 100 MB)..."
  $zip = Join-Path $env:TEMP 'ffmpeg.zip'
  Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip
  if (Test-Path (Join-Path $Tools 'ffmpeg')) { Remove-Item (Join-Path $Tools 'ffmpeg') -Recurse -Force }
  Expand-Archive $zip -DestinationPath (Join-Path $Tools 'ffmpeg') -Force
  $ffmpeg = Get-ChildItem -Path (Join-Path $Tools 'ffmpeg') -Filter ffmpeg.exe -Recurse | Select-Object -First 1
}
$ffmpegPath = $ffmpeg.FullName
$ffprobePath = Join-Path $ffmpeg.DirectoryName 'ffprobe.exe'
Write-Host "    FFmpeg: $ffmpegPath"

# ---------------------------------------------------------------- 3. Detener la version anterior (si existe)
function Detener-Radio {
  Stop-ScheduledTask -TaskName 'RadioDonManuel' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*RadioDonManuel*' -or $_.ExecutablePath -like "$Tools*" } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*iniciar-radio.cmd*' } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Start-Sleep -Seconds 2
}
Detener-Radio

# ---------------------------------------------------------------- 4. Programa de la radio
Paso "Descargando la radio desde GitHub..."
$zip = Join-Path $env:TEMP 'radio.zip'
Invoke-WebRequest 'https://github.com/Jhonmclx/RADIO-MERCADOS-DON-MANUEL/archive/refs/heads/main.zip' -OutFile $zip
$tmp = Join-Path $env:TEMP 'radio-src'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Select-Object -First 1
if (Test-Path $App) { Remove-Item $App -Recurse -Force }
Move-Item $src.FullName $App

# ---------------------------------------------------------------- 5. Configuracion
if (-not (Test-Path $EnvGuardado)) {
  Paso "Configuracion (solo la primera vez)"
  Write-Host "    Copie estos dos valores de Render > su servicio > Environment."
  Write-Host "    (Sirven para traer la musica y los comerciales que ya subio. NO los pegue en ningun chat.)"
  $supaUrl = Read-Host "    SUPABASE_URL"
  $supaKey = Read-Host "    SUPABASE_SERVICE_KEY"
  $lineas = @(
    'NODE_ENV=production',
    'PORT=8080',
    'HOST=127.0.0.1',
    'TIMEZONE=America/Bogota',
    "DATA_DIR=$($Datos -replace '\\','/')",
    "BACKUP_DIR=$((Join-Path $Datos 'backups') -replace '\\','/')",
    "FFMPEG_PATH=$($ffmpegPath -replace '\\','/')",
    "FFPROBE_PATH=$($ffprobePath -replace '\\','/')",
    'TRUST_PROXY=true',
    'COOKIE_SECURE=true',
    'VIDEO_WIDTH=1280',
    'VIDEO_HEIGHT=720',
    'VIDEO_BITRATE_KBPS=1500',
    'X264_PRESET=veryfast',
    'BACKUP_VIDEO_HEIGHT=240',
    'SYNC_TARGET_DELAY_MS=18000',
    "SUPABASE_URL=$supaUrl",
    "SUPABASE_SERVICE_KEY=$supaKey",
    'SUPABASE_BUCKET=radio-mercado',
    'SUPABASE_MODE=solo-migrar'
  )
  Set-Content -Path $EnvGuardado -Value $lineas -Encoding ASCII
} else {
  # Actualizacion: se conservan los valores, pero las rutas de las herramientas se renuevan.
  $l = Get-Content $EnvGuardado | Where-Object { $_ -notmatch '^(FFMPEG_PATH|FFPROBE_PATH)=' }
  $l += "FFMPEG_PATH=$($ffmpegPath -replace '\\','/')"
  $l += "FFPROBE_PATH=$($ffprobePath -replace '\\','/')"
  Set-Content -Path $EnvGuardado -Value $l -Encoding ASCII
}
Copy-Item $EnvGuardado (Join-Path $App '.env') -Force

# ---------------------------------------------------------------- 6. Arranque automatico
Paso "Dejando la radio para que arranque sola al encender el PC..."
$cmdFile = Join-Path $Base 'iniciar-radio.cmd'
$log = Join-Path $Base 'radio.log'
$contenido = @(
  '@echo off',
  'rem Mantiene la radio funcionando: si se cierra por un error, vuelve a arrancar a los 10 segundos.',
  ":inicio",
  "cd /d `"$App`"",
  "`"$node`" --disable-warning=ExperimentalWarning src\server.js >> `"$log`" 2>&1",
  'timeout /t 10 /nobreak >nul',
  'goto inicio'
)
Set-Content -Path $cmdFile -Value $contenido -Encoding ASCII
$accion = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmdFile`"" -WorkingDirectory $App
$disparador = New-ScheduledTaskTrigger -AtStartup
$cuenta = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 7 -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'RadioDonManuel' -Action $accion -Trigger $disparador -Principal $cuenta -Settings $ajustes -Force | Out-Null

# Vigilante: cada 5 minutos revisa que la radio y Tailscale estén funcionando y los levanta si se cayeron
# (por ejemplo si alguien cerró Tailscale, cerró sesión o la radio se detuvo).
$vig = Join-Path $Base 'vigilante.ps1'
$vigTexto = @'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$log = 'C:\RadioDonManuel\vigilante.log'
function Nota($t) { Add-Content -Path $log -Value ("[" + (Get-Date -Format s) + "] " + $t) }
try {
  $tarea = Get-ScheduledTask -TaskName 'RadioDonManuel' -ErrorAction Stop
  $ok = $false
  try { $ok = (Invoke-WebRequest 'http://127.0.0.1:8080/healthz' -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200 } catch { }
  if ($tarea.State -ne 'Running') { Nota 'La radio estaba detenida: se inicia.'; Start-ScheduledTask -TaskName 'RadioDonManuel' }
  elseif (-not $ok) { Nota 'La radio no responde (puede estar arrancando).' }
} catch { Nota ("Error revisando la radio: " + $_) }
if (Test-Path $ts) {
  try {
    $st = (& $ts status --json | Out-String | ConvertFrom-Json).BackendState
    if ($st -ne 'Running') { Nota ("Tailscale estaba en " + $st + ": se conecta."); & $ts up --unattended 2>&1 | Out-Null }
    $f = (& $ts funnel status 2>&1 | Out-String)
    if ($f -notmatch '8080') { Nota 'El link publico estaba apagado: se activa.'; & $ts funnel --bg 8080 2>&1 | Out-Null }
  } catch { Nota ("Error revisando Tailscale: " + $_) }
}
'@
Set-Content -Path $vig -Value $vigTexto -Encoding UTF8
$vAccion = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$vig`""
$vDisparos = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
)
$vAjustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'RadioDonManuel-Vigilante' -Action $vAccion -Trigger $vDisparos -Principal $cuenta -Settings $vAjustes -Force | Out-Null
Start-ScheduledTask -TaskName 'RadioDonManuel'

# Que el PC no se duerma mientras esta conectado a la corriente (si se duerme, la radio se detiene).
powercfg /change standby-timeout-ac 0 | Out-Null

Paso "Esperando a que la radio arranque (la primera vez trae la musica desde Supabase: puede tardar varios minutos)..."
$listo = $false
for ($i = 0; $i -lt 180; $i++) {
  try { $r = Invoke-WebRequest 'http://127.0.0.1:8080/healthz' -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200) { $listo = $true; break } } catch { }
  Start-Sleep -Seconds 5
}
if (-not $listo) {
  Aviso "La radio todavia no responde. Revise el archivo $log y envie una foto de las ultimas lineas."
} else {
  Write-Host "    La radio funciona en este PC: http://localhost:8080/admin/" -ForegroundColor Green
}

# ---------------------------------------------------------------- 7. Link publico con Tailscale
if (-not $SinTailscale) {
  $ts = 'C:\Program Files\Tailscale\tailscale.exe'
  if (-not (Test-Path $ts)) {
    Paso "Instalando Tailscale (para que los TV de las otras sedes lleguen a este PC)..."
    $msi = Join-Path $env:TEMP 'tailscale.msi'
    Invoke-WebRequest 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait
    Start-Sleep -Seconds 5
  }
  Paso "Conectando Tailscale: se abrira el navegador para iniciar sesion (puede usar su cuenta de Google)."
  & $ts up --unattended
  Paso "Publicando la radio con un link https (Tailscale Funnel)..."
  Aviso "Si aparece un link para 'habilitar Funnel' o 'HTTPS', abralo, apruebe y vuelva a ejecutar este instalador."
  & $ts funnel --bg 8080
  $dns = ((& $ts status --json) | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
  if ($dns) {
    $url = "https://$dns"
    $l = Get-Content $EnvGuardado | Where-Object { $_ -notmatch '^PUBLIC_BASE_URL=' }
    $l += "PUBLIC_BASE_URL=$url"
    Set-Content -Path $EnvGuardado -Value $l -Encoding ASCII
    Copy-Item $EnvGuardado (Join-Path $App '.env') -Force
    Detener-Radio
    Start-ScheduledTask -TaskName 'RadioDonManuel'
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host " RADIO MERCADO DON MANUEL instalada en este PC"
    Write-Host " Panel:  $url/admin/"
    Write-Host " TV:     $url/player/alto-del-espino?local=1"
    Write-Host "         $url/player/gourmet?local=1"
    Write-Host "         $url/player/parque-narino?local=1"
    Write-Host "         $url/player/terminal?local=1"
    Write-Host "         $url/player/sachica?local=1"
    Write-Host "================================================================" -ForegroundColor Green
  }
}
