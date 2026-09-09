<#
    Делает ярлыки для запуска программы.

    В папке программы ярлык кладём всегда: батник нужен только для первой
    установки, а запускать программу человек должен обычным значком.
    Про рабочий стол спрашиваем — это его стол, а не наш.
#>

param(
    # Не спрашивать про рабочий стол — так зовёт запускалка при обновлении,
    # когда ярлык в папке просто потерялся.
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
# Запускать надо .exe; батник остаётся запасным на случай, если антивирус
# съест собранный файл.
$exe = Join-Path $root 'SiGame Helper.exe'
$bat = Join-Path $root 'Запасной запуск.bat'
$target = if (Test-Path $exe) { $exe } else { $bat }
$icon = Join-Path $root 'assets\icon.ico'

function New-Link([string]$Path) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $target
    $link.WorkingDirectory = $root
    $link.Description = 'Скачивание, нарезка и сжатие медиа для паков SIGame'
    if (Test-Path $icon) { $link.IconLocation = $icon }
    # 7 — свернуть: чёрное окно мелькает и сразу уходит в панель задач.
    $link.WindowStyle = 7
    $link.Save()
}

try {
    New-Link (Join-Path $root 'Запустить SiGame Helper.lnk')
    Write-Host '  Ярлык для запуска положен в папку программы.' -ForegroundColor Green
}
catch {
    Write-Host "  Ярлык в папке создать не удалось: $($_.Exception.Message)"
}

if ($Silent) { exit 0 }

try {
    Add-Type -AssemblyName System.Windows.Forms
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "Создать ярлык «SiGame Helper» на рабочем столе?" + [Environment]::NewLine + [Environment]::NewLine +
        "Ярлык для запуска уже положен в папку программы.",
        'SiGame Helper',
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
        New-Link (Join-Path ([Environment]::GetFolderPath('Desktop')) 'SiGame Helper.lnk')
        Write-Host '  Ярлык создан на рабочем столе.' -ForegroundColor Green
    }
    else {
        Write-Host '  На рабочем столе ярлык не создаём.'
    }
}
catch {
    Write-Host "  Спросить про рабочий стол не удалось: $($_.Exception.Message)"
}

exit 0
