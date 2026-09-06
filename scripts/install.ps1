<#
    Готовит всё, что нужно SiGame Helper, и ничего не спрашивает.

    Python не требуется: сюда скачивается официальная переносимая сборка
    с python.org и разворачивается в папку runtime рядом с программой.
    Она никак не влияет на систему — её можно просто удалить вместе с папкой.
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root    = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$marker  = Join-Path $runtime '.ready'

$version = '3.12.10'
$zipUrl  = "https://www.python.org/ftp/python/$version/python-$version-embed-amd64.zip"
$pipUrl  = 'https://bootstrap.pypa.io/get-pip.py'

function Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "  $text" -ForegroundColor Green }

Write-Host ''
Write-Host '  SiGame Helper — первая подготовка' -ForegroundColor White
Write-Host '  ------------------------------------------------'
Write-Host '  Займёт несколько минут. Ставить ничего не нужно,'
Write-Host '  всё складывается в папки рядом с программой.'
Write-Host ''

try {
    if (Test-Path $marker) {
        Done 'Python уже подготовлен.'
    }
    else {
        # Обрывок прошлой неудачной попытки лучше снести целиком.
        if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }

        Step "[1/4] Скачиваю Python $version (11 МБ)..."
        $zip = Join-Path $env:TEMP "sgh-python-$version.zip"
        Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing

        Step '[2/4] Распаковываю...'
        Expand-Archive -Path $zip -DestinationPath $runtime -Force
        Remove-Item $zip -Force

        # Встроенная сборка по умолчанию не видит установленные пакеты:
        # за это отвечает файл ._pth, его нужно дополнить.
        $pth = Get-ChildItem -Path $runtime -Filter 'python*._pth' | Select-Object -First 1
        Set-Content -Path $pth.FullName -Encoding ASCII -Value @(
            [IO.Path]::GetFileNameWithoutExtension($pth.Name) + '.zip'
            '.'
            'Lib\site-packages'
            ''
            'import site'
        )

        Step '[3/4] Ставлю pip...'
        $getpip = Join-Path $runtime 'get-pip.py'
        Invoke-WebRequest -Uri $pipUrl -OutFile $getpip -UseBasicParsing
        & (Join-Path $runtime 'python.exe') $getpip --no-warn-script-location -q
        if ($LASTEXITCODE -ne 0) { throw 'не удалось установить pip' }
        Remove-Item $getpip -Force

        # Часть библиотек выложена без готовых «колёс» (например proxy-tools,
        # который тянет за собой pywebview) и собирается из исходников прямо
        # на месте. Для сборки нужны setuptools и wheel, а во встроенной
        # сборке Python их нет — ставим сами.
        & (Join-Path $runtime 'python.exe') -m pip install --no-warn-script-location -q setuptools wheel
        if ($LASTEXITCODE -ne 0) { throw 'не удалось установить setuptools' }

        # --no-build-isolation обязателен: встроенный Python из-за файла ._pth
        # работает в изолированном режиме и не видит PYTHONPATH, через который
        # pip подсовывает setuptools во временное окружение сборки. Без этого
        # флага установка падает на «Cannot import setuptools.build_meta».
        Step '[4/4] Ставлю библиотеки и загрузчики (это самый долгий шаг)...'
        & (Join-Path $runtime 'python.exe') -m pip install --no-warn-script-location --no-build-isolation -q -r (Join-Path $root 'backend\requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'не удалось установить библиотеки' }

        New-Item -ItemType File -Path $marker -Force | Out-Null
        Done 'Python и библиотеки готовы.'
    }
}
catch {
    Write-Host ''
    Write-Host '  [!] Подготовка не удалась.' -ForegroundColor Red
    Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    Write-Host '      Чаще всего это интернет: проверьте соединение и запустите'
    Write-Host '      "SiGame Helper.bat" ещё раз. Антивирус тоже иногда блокирует'
    Write-Host '      загрузку — тогда добавьте папку программы в исключения.'
    Write-Host ''
    exit 1
}

exit 0
