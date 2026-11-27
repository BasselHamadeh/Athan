# Echter Funktionstest der Windows-App auf einem Windows-Rechner (GitHub Actions):
# MSI installieren → Athan.exe starten → Gebet in ~2 Minuten → Download, Benachrichtigung, Athan, Stopp → deinstallieren.
param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
$script:fail = 0
function Check($name, $cond) { if ($cond) { Write-Host "OK   $name" } else { Write-Host "FAIL $name"; $script:fail++ } }

# Audiodienst starten (auf Windows Server standardmäßig aus)
Set-Service -Name Audiosrv -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service -Name Audiosrv -ErrorAction SilentlyContinue

$msi = Resolve-Path "dist/Athan-Setup-$Version.msi"
$p = Start-Process msiexec -ArgumentList "/i `"$msi`" /qn /l*v install.log" -Wait -PassThru
if ($p.ExitCode -ne 0) {
  Get-Content install.log -Encoding Unicode | Select-String 'Return value 3|Note: 1: 1[0-9]{3}' | Select-Object -Last 30 | ForEach-Object { $_.Line }
  throw "Installation fehlgeschlagen: $($p.ExitCode)"
}
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Athan\Athan.exe'
Check 'Athan.exe installiert' (Test-Path $exe)
Check 'Startmenü-Verknüpfung' (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Athan.lnk'))
Check 'Desktop-Verknüpfung' (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Athan.lnk'))
$run = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).Athan
Check "Autostart-Eintrag ($run)" ($run -like '*Athan.exe*--background')

# Ort so wählen, dass in 1–2 Minuten ein Gebet fällig ist
$f = node tests/find-prayer.mjs | ConvertFrom-Json
Write-Host "Testgebet: $($f.prayer) um $([DateTimeOffset]::FromUnixTimeMilliseconds($f.at).UtcDateTime.ToString('HH:mm')) UTC (Längengrad $($f.lon))"
$cfg = Join-Path $env:APPDATA 'Athan'
New-Item -ItemType Directory -Force $cfg | Out-Null
$settings = @{
  location = @{ name = 'Testort'; lat = 25; lon = $f.lon; tz = 'UTC' }
  calc = @{ method = 'MWL' }; voice = 'makkah_mulla'; fajrVoice = 'auto'; volume = 0.8; pre = 0; clock = '24'
  modes = @{ fajr = 'athan'; sunrise = 'off'; dhuhr = 'athan'; asr = 'athan'; maghrib = 'athan'; isha = 'athan' }
} | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $cfg 'settings.json'), $settings)

$proc = Start-Process $exe -ArgumentList '--background' -PassThru
Start-Sleep 6
$sess = (Get-Content (Join-Path $cfg 'session')) -split ' '
$base = "http://127.0.0.1:$($sess[0])"
$h = @{ 'X-Athan-Token' = $sess[1] }
Check 'Lokale API antwortet' ((Invoke-RestMethod "$base/api/ping") -eq 'athan')
$st = Invoke-RestMethod "$base/api/state" -Headers $h
Check 'Einstellungen geladen' ($st.settings.location.name -eq 'Testort')
$blocked = $false
try { Invoke-RestMethod "$base/api/state" | Out-Null } catch { $blocked = $true }
Check 'API ohne Token gesperrt' $blocked
$ui = Invoke-WebRequest "$base/" -UseBasicParsing
Check 'Oberfläche ausgeliefert' ($ui.Content -match 'athan-desktop')

$wait = [Math]::Max(0, ($f.at - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 1000) + 25
Write-Host "Warte $([int]$wait) s bis nach dem Gebet …"
Start-Sleep $wait
$st = Invoke-RestMethod "$base/api/status" -Headers $h
$log = Get-Content (Join-Path $env:LOCALAPPDATA 'Athan\athan.log') -Raw
Write-Host "Audiogeräte: $((Get-CimInstance Win32_SoundDevice | ForEach-Object Name) -join ', ')"
Write-Host '---- athan.log ----'; Write-Host $log; Write-Host '-------------------'
Check 'Tray-Symbol angelegt' ($log -match 'Tray-Symbol bereit')
Check 'Athan-Aufnahme heruntergeladen' ($log -match 'Aufnahme makkah_mulla geladen')
Check 'Gebet ausgelöst' ($log -match '\(athan\)')
Check 'Benachrichtigung angezeigt' ($log -match 'Benachrichtigung angezeigt: Zeit für')
Check 'Athan spielt' ($log -match 'Athan spielt: makkah')
Check 'Status meldet laufenden Athan' ($null -ne $st.playing)
Invoke-RestMethod "$base/api/stop" -Method Post -Headers $h | Out-Null
Start-Sleep 2
Check 'Stopp funktioniert' ($null -eq (Invoke-RestMethod "$base/api/status" -Headers $h).playing)

# Sichtprüfung: Oberfläche mit Berlin als Ort im Edge-Fenster fotografieren
$berlin = @{
  location = @{ name = 'Berlin'; region = 'Berlin'; country = 'Deutschland'; cc = 'DE'; lat = 52.52; lon = 13.405; tz = 'Europe/Berlin' }
  calc = @{ method = 'MWL'; asr = 'standard'; highLat = 'angle' }; voice = 'makkah_mulla'; fajrVoice = 'auto'; volume = 0.8; pre = 0; clock = '24'
  modes = @{ fajr = 'athan'; sunrise = 'off'; dhuhr = 'athan'; asr = 'athan'; maghrib = 'athan'; isha = 'athan' }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/api/settings" -Method Put -Headers $h -ContentType 'application/json' -Body $berlin | Out-Null
try { node tests/windows-shots.mjs $base } catch { Write-Host "Screenshots nicht möglich: $_" }

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep 1
$p = Start-Process msiexec -ArgumentList "/x `"$msi`" /qn" -Wait -PassThru
Check 'Deinstallation' ($p.ExitCode -eq 0)
Check 'Programm entfernt' (-not (Test-Path $exe))
Check 'Autostart entfernt' ($null -eq (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).Athan)
if ($script:fail) { throw "$($script:fail) Prüfung(en) fehlgeschlagen" }
Write-Host 'Windows-App: alle Prüfungen bestanden'
