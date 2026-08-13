$ErrorActionPreference = "Stop"
$gh = "$env:ProgramFiles\GitHub CLI\gh.exe"
$projectDir = $PSScriptRoot

Set-Location $projectDir

if (-not (Test-Path $gh)) {
    Write-Host "GitHub CLI bulunamadi. Once 'winget install GitHub.cli' calistirin." -ForegroundColor Red
    exit 1
}

& $gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "GitHub girisi gerekli. Asagidaki komutu calistirin:" -ForegroundColor Yellow
    Write-Host "  gh auth login" -ForegroundColor Cyan
    exit 1
}

$repoName = "video-meeting-rooms"
Write-Host "Repo olusturuluyor: $repoName" -ForegroundColor Green

& $gh repo create $repoName --public --source=. --remote=origin --push --description "4 odali goruntulu ve sesli toplanti uygulamasi (WebRTC + Socket.io)"

if ($LASTEXITCODE -eq 0) {
    $url = & $gh repo view --json url -q .url
    Write-Host ""
    Write-Host "Basarili! Repo adresi:" -ForegroundColor Green
    Write-Host $url -ForegroundColor Cyan
} else {
    Write-Host "Repo olusturulamadi. Repo adi kullaniliyor olabilir." -ForegroundColor Red
    exit 1
}
