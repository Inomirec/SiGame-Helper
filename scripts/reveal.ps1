<#
    Показывает файл в проводнике, не плодя окна.

    "explorer /select" всегда открывает НОВОЕ окно, и после десятка проверок
    скачанного человек закрывает десяток проводников. Поэтому сначала ищем
    уже открытое окно с этой папкой: если нашли — выделяем файл в нём и
    поднимаем его наверх, и только иначе открываем новое.
#>

param(
    [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Stop'

$item = Get-Item -LiteralPath $Path
$folder = if ($item.PSIsContainer) { $item.FullName } else { $item.DirectoryName }
$name = if ($item.PSIsContainer) { $null } else { $item.Name }

Add-Type -Namespace Win -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@

try {
    $shell = New-Object -ComObject Shell.Application
    foreach ($window in @($shell.Windows())) {
        # Среди окон Shell.Application попадаются и вкладки браузера — у них
        # нет папки, поэтому обращаемся осторожно.
        $open = $null
        try { $open = $window.Document.Folder.Self.Path } catch { continue }
        if (-not $open) { continue }
        if ([IO.Path]::GetFullPath($open).TrimEnd('\') -ne [IO.Path]::GetFullPath($folder).TrimEnd('\')) { continue }

        if ($name) {
            try {
                $target = $window.Document.Folder.ParseName($name)
                # 1 = выделить, 8 = сделать текущим, 16 = прокрутить к нему
                if ($target) { $window.Document.SelectItem($target, 1 -bor 8 -bor 16) }
            } catch { }
        }
        [Win.Api]::ShowWindow([IntPtr]$window.HWND, 9) | Out-Null   # 9 — развернуть, если свёрнуто
        [Win.Api]::SetForegroundWindow([IntPtr]$window.HWND) | Out-Null
        exit 0
    }
}
catch {
    # Не смогли осмотреть открытые окна — просто откроем новое.
}

if ($name) {
    Start-Process explorer.exe -ArgumentList "/select,`"$($item.FullName)`""
} else {
    Start-Process explorer.exe -ArgumentList "`"$folder`""
}
exit 0
