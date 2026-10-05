# CDC debug log auto reader (TASK 7)
#
# After flashing the debug FW (CONFIG_TYPECTOY_DEBUG_CDC=y) and selecting
# Game -> Phone(PCM) on the device, the CoreS3 enumerates as a UAC+CDC
# composite and a new COM port appears. This reads [STAT ...] lines from it
# and summarizes FR/CE/OV/L etc.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File web/cdc-log-reader.ps1 -Port COMxx -Seconds 60

param(
    [string]$Port = "",
    [int]$Seconds = 60,
    [int]$Baud = 115200
)

function Get-ComPorts {
    Get-CimInstance Win32_PnPEntity |
        Where-Object { $_.Name -match '\(COM(\d+)\)' } |
        ForEach-Object { if ($_.Name -match '\(COM(\d+)\)') { "COM$($matches[1])" } } |
        Sort-Object -Unique
}

if ([string]::IsNullOrEmpty($Port)) {
    Write-Host "[cdc-reader] auto-detecting new COM port..." -ForegroundColor Cyan
    $before = @(Get-ComPorts)
    Write-Host "[cdc-reader] current ports: $($before -join ', ')"
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $now = @(Get-ComPorts)
        $new = @($now | Where-Object { $before -notcontains $_ })
        if ($new.Count -gt 0) {
            $Port = $new[0]
            Write-Host "[cdc-reader] new port: $Port" -ForegroundColor Green
            break
        }
    }
    if ([string]::IsNullOrEmpty($Port)) {
        Write-Host "[cdc-reader] no new port. re-run with -Port COMxx" -ForegroundColor Red
        exit 1
    }
    Start-Sleep -Seconds 1
}

Write-Host "[cdc-reader] opening $Port at $Baud bps for $Seconds s..." -ForegroundColor Cyan

$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
$sp.ReadTimeout = 500
$sp.NewLine = "`n"
# firmware tud_cdc_connected() becomes true only when host asserts DTR.
$sp.DtrEnable = $true
$sp.RtsEnable = $true
try {
    $sp.Open()
} catch {
    Write-Host "[cdc-reader] cannot open port: $_" -ForegroundColor Red
    exit 1
}

$firstStat = $null
$lastStat = $null
$lineCount = 0

$end = (Get-Date).AddSeconds($Seconds)
try {
    while ((Get-Date) -lt $end) {
        $line = $null
        try {
            $line = $sp.ReadLine()
        } catch {
            # timeout or close-induced abort: just loop/exit on deadline
            continue
        }
        if ($null -eq $line) { continue }
        $line = $line.Trim()
        if ($line.Length -eq 0) { continue }
        Write-Host $line
        if ($line -match '^\[STAT') {
            $lineCount++
            if ($null -eq $firstStat) { $firstStat = $line }
            $lastStat = $line
        }
    }
} finally {
    $sp.Close()
}

Write-Host ""
Write-Host "===== summary =====" -ForegroundColor Cyan
Write-Host "STAT lines: $lineCount"
if ($firstStat) { Write-Host "first: $firstStat" }
if ($lastStat)  { Write-Host "last : $lastStat" }

function Parse-Field($line, $key) {
    if ($line -match "$key=(-?\d+)") { return [int64]$matches[1] }
    return $null
}

if ($firstStat -and $lastStat) {
    $frA = Parse-Field $firstStat 'FR'; $frB = Parse-Field $lastStat 'FR'
    $ceA = Parse-Field $firstStat 'CE'; $ceB = Parse-Field $lastStat 'CE'
    $ovA = Parse-Field $firstStat 'OV'; $ovB = Parse-Field $lastStat 'OV'
    Write-Host ""
    Write-Host "delta (last-first):" -ForegroundColor Cyan
    if ($null -ne $frB -and $null -ne $frA) { Write-Host "  FR (crc-ok frames) += $($frB - $frA)" }
    if ($null -ne $ceB -and $null -ne $ceA) { Write-Host "  CE (crc errors)    += $($ceB - $ceA)" }
    if ($null -ne $ovB -and $null -ne $ovA) { Write-Host "  OV (fifo overflow) += $($ovB - $ovA)" }
    Write-Host ""
    if (($frB - $frA) -gt 0) {
        Write-Host "RESULT: browser->device frames decode OK (FR increasing)." -ForegroundColor Green
    } else {
        Write-Host "RESULT: device decodes NO valid frame (FR flat). browser TX waveform/path issue." -ForegroundColor Red
    }
}
