#Requires -Version 5.1
<#
.SYNOPSIS
    一键写入 Kaggle 凭据：运行后粘贴密钥，脚本自动填写到所有该在的位置。

.DESCRIPTION
    双击同目录下的「一键配置Kaggle密钥.cmd」即可（也可直接运行本脚本）。

    脚本做四件事：
      1. 列出当前生效的凭据，避免新旧密钥互相顶替；
      2. 验证你粘贴的密钥（调用 Kaggle /api/v1/hello），并自动识别账号用户名；
      3. 写入 ~/.kaggle/access_token（Bearer）或 ~/.kaggle/kaggle.json（用户名 + Key），
         同时在 <工作区>/.secrets/kaggle.env 留一份本地兜底，并删除相互冲突的旧文件；
      4. 用户名发生变化时，同步 DSH profile 里的 KAGGLE_RVC_USERNAME（会先备份）。

    密钥只写文件、不进日志，屏幕上只显示打码预览。脚本可反复运行。

.PARAMETER Token
    密钥本体，便于自动化：KGAT_… 走 Bearer；否则配合 -Username 走 Basic。
    不传则交互式提示输入（输入不回显）。

.PARAMETER Username
    Kaggle 用户名。仅有 Bearer Token 时可省略 —— 脚本会通过 /hello 自动识别。

.PARAMETER TokenFile
    从文件读取密钥（如 ~/.kaggle/access_token），便于脚本化测试。

.PARAMETER Workspace
    工作区根目录，默认脚本所在目录；.secrets/kaggle.env 写在这里。

.PARAMETER NoVerify
    跳过在线验证与用户名自动识别（离线场景）。

.PARAMETER NoProfileSync
    不改动 DSH profile 里的 KAGGLE_RVC_USERNAME。

.EXAMPLE
    .\setup-kaggle.ps1
    交互式：粘贴密钥 → 自动写入 → 自动验证。
#>
[CmdletBinding()]
param(
    [string]$Token,
    [string]$Username,
    [string]$TokenFile,
    [string]$Workspace,
    [switch]$NoVerify,
    [switch]$NoProfileSync
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 兜底：任何没被局部捕获的终止性错误都给一句人话，而不是甩一段 .NET 堆栈。
trap {
    Write-Host ''
    Write-Host "  [x]  脚本出错: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  凭据可能未被改动；修正后重新运行即可。' -ForegroundColor Yellow
    exit 1
}

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Bom = New-Object System.Text.UTF8Encoding($true)
$script:HelloUrl = 'https://www.kaggle.com/api/v1/hello'

function Say { param([string]$m) Write-Host $m }
function SayOk { param([string]$m) Write-Host "  [OK] $m" -ForegroundColor Green }
function SayNote { param([string]$m) Write-Host "  --   $m" -ForegroundColor DarkGray }
function SayWarn { param([string]$m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function SayBad { param([string]$m) Write-Host "  [x]  $m" -ForegroundColor Red }
function Head { param([string]$m) Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }

function Mask([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return '(空)' }
    if ($s.Length -le 12) { return ('*' * $s.Length) }
    return $s.Substring(0, 6) + ('*' * 8) + $s.Substring($s.Length - 4)
}

function Write-Text {
    param([string]$Path, [string]$Text, [switch]$Bom)
    $enc = $script:Utf8NoBom
    if ($Bom) { $enc = $script:Utf8Bom }
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Read-Secret {
    param([string]$Prompt)
    try {
        $sec = Read-Host -Prompt $Prompt -AsSecureString
    } catch {
        throw '当前环境无法交互输入；请用 -Token 或 -TokenFile 参数。'
    }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Confirm-Yes {
    param([string]$Prompt)
    try { $a = Read-Host -Prompt $Prompt } catch { return $false }
    return ($a -match '^(y|yes|是)$')
}

function Remove-Cred {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force
        SayNote "已删除旧凭据: $Path"
        return $true
    }
    return $false
}

# 写之前先探一次目录可写性，避免写了一半失败、留下半套凭据。
function Test-DirWritable {
    param([string]$Dir)
    try {
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        $probe = Join-Path $Dir ('.setup-kaggle-write-test-' + [guid]::NewGuid().ToString('N'))
        [System.IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force
        return $true
    } catch {
        return $false
    }
}

# 用 Node 探针验证密钥（Node 自带 TLS 栈，受限环境下比 Invoke-RestMethod 可靠）。
function Test-Credential {
    param([string]$Secret, [string]$User, [string]$Key)

    $node = Get-Command node -ErrorAction SilentlyContinue
    $helper = Join-Path $PSScriptRoot 'tools\kaggle-hello.mjs'
    if ($node -and (Test-Path -LiteralPath $helper)) {
        $savedT = $env:KAGGLE_HELLO_TOKEN
        $savedU = $env:KAGGLE_HELLO_USERNAME
        $savedK = $env:KAGGLE_HELLO_KEY
        try {
            $env:KAGGLE_HELLO_TOKEN = $null
            $env:KAGGLE_HELLO_USERNAME = $null
            $env:KAGGLE_HELLO_KEY = $null
            if ($Key) {
                $env:KAGGLE_HELLO_USERNAME = $User
                $env:KAGGLE_HELLO_KEY = $Key
            } else {
                $env:KAGGLE_HELLO_TOKEN = $Secret
            }
            $raw = (& $node.Source $helper 2>$null) | Out-String
            $obj = $null
            try { $obj = $raw.Trim() | ConvertFrom-Json } catch { $obj = $null }
            if ($obj) { return [pscustomobject]@{ Ok = [bool]$obj.ok; Status = $obj.status; UserName = $obj.userName; Error = $obj.error; Via = 'node' } }
            return [pscustomobject]@{ Ok = $false; Status = 0; UserName = $null; Error = "探针无输出: $($raw.Trim())"; Via = 'node' }
        } finally {
            $env:KAGGLE_HELLO_TOKEN = $savedT
            $env:KAGGLE_HELLO_USERNAME = $savedU
            $env:KAGGLE_HELLO_KEY = $savedK
        }
    }

    # 兜底：直接用 PowerShell 请求（需要 .NET 侧 TLS 可用）。
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $headers = @{ Accept = 'application/json'; 'User-Agent' = 'kaggle-free-gpu-setup/0.1' }
        if ($Key) {
            $headers.Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${User}:${Key}"))
        } else {
            $headers.Authorization = "Bearer $Secret"
        }
        $r = Invoke-RestMethod -Uri $script:HelloUrl -Headers $headers -Method Get -TimeoutSec 30
        return [pscustomobject]@{ Ok = [bool]$r.userName; Status = 200; UserName = $r.userName; Error = $null; Via = 'powershell' }
    } catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ Ok = $false; Status = $status; UserName = $null; Error = $_.Exception.Message; Via = 'powershell' }
    }
}

function Sync-ProfileUsername {
    param([string]$UserName)
    $changed = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    $root = Join-Path $env:USERPROFILE '.dsh\profiles'
    if (-not (Test-Path -LiteralPath $root)) { return [pscustomobject]@{ Changed = $changed; Skipped = $skipped; Root = $root } }

    $pattern = '(?m)^([ \t]*KAGGLE_RVC_USERNAME:[ \t]*)([^\r\n#]+)'
    foreach ($dir in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
        $patch = Join-Path $dir.FullName 'cordis.patch.yml'
        if (-not (Test-Path -LiteralPath $patch)) { continue }
        $bytes = [System.IO.File]::ReadAllBytes($patch)
        $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        $text = [System.IO.File]::ReadAllText($patch)
        if ($text -notmatch 'KAGGLE_RVC_USERNAME') { continue }

        $current = ([regex]::Match($text, $pattern)).Groups[2].Value.Trim()
        if ($current -eq $UserName) {
            [void]$skipped.Add("$patch (已是 $UserName)")
            continue
        }

        $backup = "$patch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item -LiteralPath $patch -Destination $backup -Force
        $new = [regex]::Replace($text, $pattern, ('${1}' + $UserName))
        Write-Text -Path $patch -Text $new -Bom:$hasBom
        [void]$changed.Add("$patch  ($current -> $UserName)")
    }
    return [pscustomobject]@{ Changed = $changed; Skipped = $skipped; Root = $root }
}

# ------------------------------------------------------------------ 主流程

Say ''
Say '============================================================'
Say '  Kaggle 凭据一键配置   (setup-kaggle.ps1)'
Say '============================================================'

if (-not $Workspace) {
    if ($PSScriptRoot) { $Workspace = $PSScriptRoot } else { $Workspace = (Get-Location).Path }
}
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path

$homeKaggle = Join-Path $env:USERPROFILE '.kaggle'
$tokenPath = Join-Path $homeKaggle 'access_token'
$jsonPath = Join-Path $homeKaggle 'kaggle.json'
$secretsDir = Join-Path $Workspace '.secrets'
$envPath = Join-Path $secretsDir 'kaggle.env'
$localJsonPath = Join-Path $secretsDir 'kaggle.json'

Head '1/5  当前凭据'
SayNote "工作区: $Workspace"
if ($env:KAGGLE_API_TOKEN) { SayWarn '环境变量 KAGGLE_API_TOKEN 已设置（优先级最高，会盖过下面所有文件）' }
if ($env:KAGGLE_USERNAME -and $env:KAGGLE_KEY) { SayWarn '环境变量 KAGGLE_USERNAME/KAGGLE_KEY 已设置（优先级次高）' }
$existing = New-Object System.Collections.ArrayList
foreach ($p in @($tokenPath, $jsonPath, $envPath, $localJsonPath)) {
    if (Test-Path -LiteralPath $p) { [void]$existing.Add($p) }
}
if ($existing.Count -eq 0) {
    SayNote '（没有找到任何本地凭据文件）'
} else {
    foreach ($p in $existing) { SayNote "存在: $p" }
    SayNote "其中生效的是: $($existing[0])"
}

Head '2/5  输入密钥'
if (-not $Token -and $TokenFile) {
    if (-not (Test-Path -LiteralPath $TokenFile)) { SayBad "找不到文件: $TokenFile"; exit 1 }
    $Token = ([System.IO.File]::ReadAllText($TokenFile)).Trim()
    SayNote "已从文件读取密钥: $TokenFile"
}
if (-not $Token) {
    SayNote '在 Kaggle 账号页 (Settings → API) 复制 API Token，或使用旧的 用户名 + Key。'
    SayNote '粘贴时不会回显，粘贴完直接回车。留空回车 = 取消。'
    $Token = Read-Secret '  请粘贴 Kaggle 密钥'
}
$secret = ($Token | Out-String).Trim()
$secret = $secret.Trim([char]'"').Trim("'").Trim()
if (-not $secret) { SayBad '没有输入密钥，已取消。'; exit 1 }

$mode = 'bearer'
$userForBasic = $Username
if ($secret.StartsWith('{')) {
    # 支持直接粘贴 kaggle.json 的内容
    try {
        $j = $secret | ConvertFrom-Json
        if ($j.api_token) { $secret = "$($j.api_token)".Trim(); $mode = 'bearer'; if (-not $userForBasic) { $userForBasic = $j.username } }
        elseif ($j.token) { $secret = "$($j.token)".Trim(); $mode = 'bearer'; if (-not $userForBasic) { $userForBasic = $j.username } }
        elseif ($j.username -and $j.key) { $userForBasic = "$($j.username)".Trim(); $secret = "$($j.key)".Trim(); $mode = 'basic' }
        else { SayBad 'JSON 里没有 api_token / token / username+key。'; exit 1 }
        SayNote '识别到 kaggle.json 内容'
    } catch {
        SayBad "JSON 解析失败: $($_.Exception.Message)"; exit 1
    }
} elseif ($secret -match '^[^:]+:[^:]+$' -and -not $secret.StartsWith('KGAT_')) {
    $parts = $secret.Split(':', 2)
    $userForBasic = $parts[0].Trim()
    $secret = $parts[1].Trim()
    $mode = 'basic'
    SayNote "识别到 用户名:密钥 形式（用户名 $userForBasic）"
} elseif (-not $secret.StartsWith('KGAT_')) {
    $mode = 'basic'
}

if ($mode -eq 'basic') {
    if (-not $userForBasic) {
        $defaultUser = $null
        if (Test-Path -LiteralPath $envPath) {
            foreach ($line in ([System.IO.File]::ReadAllText($envPath) -split "`r?`n")) {
                if ($line -match '^\s*KAGGLE_USERNAME\s*=\s*(.+?)\s*$') { $defaultUser = $Matches[1].Trim(); break }
            }
        }
        try {
            if ($defaultUser) { $userForBasic = Read-Host -Prompt "  Kaggle 用户名（回车沿用 $defaultUser）" } else { $userForBasic = Read-Host -Prompt '  Kaggle 用户名' }
        } catch {
            SayBad '需要 Kaggle 用户名才能使用 用户名+Key 方式，请用 -Username 参数。'; exit 1
        }
        if (-not $userForBasic) { $userForBasic = $defaultUser }
    }
    if (-not $userForBasic) { SayBad '缺少 Kaggle 用户名，已取消。'; exit 1 }
    if ($userForBasic -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') {
        SayBad "用户名看起来不合法: $userForBasic"; exit 1
    }
    SayNote "认证方式: HTTP Basic（$userForBasic）"
} else {
    SayNote '认证方式: Bearer Token'
}
SayNote "密钥预览: $(Mask $secret)"

Head '3/5  在线验证'
$effectiveUser = $userForBasic
if ($NoVerify) {
    SayWarn '已跳过验证（-NoVerify）'
} else {
    if ($mode -eq 'bearer') {
        $probe = Test-Credential -Secret $secret
    } else {
        $probe = Test-Credential -Secret $null -User $userForBasic -Key $secret
    }
    if ($probe.Ok) {
        SayOk "密钥有效，账号: $($probe.UserName)  (HTTP $($probe.Status), via $($probe.Via))"
        $effectiveUser = $probe.UserName
    } else {
        SayBad "验证失败: HTTP $($probe.Status) $($probe.Error)"
        SayNote '常见原因：密钥复制不完整（粘贴时被截断）、密钥已在 Kaggle 端吊销、网络不通。'
        if (-not (Confirm-Yes '  仍然写入这份凭据吗？(y/N)')) {
            SayNote '已放弃写入，未改动任何文件。'
            exit 1
        }
        SayWarn '按要求继续写入（未通过验证）。'
    }
}

Head '4/5  写入凭据'
$unwritable = @()
foreach ($dir in @($homeKaggle, $secretsDir)) {
    if (-not (Test-DirWritable -Dir $dir)) { $unwritable += $dir }
}
if ($unwritable.Count -gt 0) {
    foreach ($dir in $unwritable) { SayBad "没有写入权限: $dir" }
    SayNote '凭据未被改动。请确认该目录属于当前用户、没有被权限策略或杀毒软件锁住，然后重试。'
    exit 1
}

$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
$envLines = New-Object System.Collections.ArrayList
[void]$envLines.Add('# Kaggle 凭据 —— 由 setup-kaggle.ps1 生成，请勿提交（.gitignore 已忽略 .secrets/）')
[void]$envLines.Add("# 生成时间: $stamp")

try {
    if ($mode -eq 'bearer') {
        Write-Text -Path $tokenPath -Text $secret
        SayOk "Bearer Token -> $tokenPath"
        [void](Remove-Cred $jsonPath)
        [void]$envLines.Add("KAGGLE_API_TOKEN=$secret")
        if ($effectiveUser) { [void]$envLines.Add("KAGGLE_USERNAME=$effectiveUser") }
    } else {
        $jsonObj = [ordered]@{ username = $effectiveUser; key = $secret }
        Write-Text -Path $jsonPath -Text ($jsonObj | ConvertTo-Json -Compress)
        SayOk "用户名 + Key -> $jsonPath"
        [void](Remove-Cred $tokenPath)
        [void]$envLines.Add("KAGGLE_USERNAME=$effectiveUser")
        [void]$envLines.Add("KAGGLE_KEY=$secret")
    }
    [void](Remove-Cred $localJsonPath)   # 第三份副本，去掉避免与 kaggle.env 不一致

    Write-Text -Path $envPath -Text (($envLines -join "`r`n") + "`r`n")
    SayOk "本地兜底凭据 -> $envPath"
} catch {
    SayBad "写入失败: $($_.Exception.Message)"
    SayNote '凭据可能只写了一半；请修正权限后重新运行本脚本（它会自行清理旧文件）。'
    exit 1
}

Head '5/5  DSH profile 用户名'
if ($NoProfileSync) {
    SayWarn '已跳过 profile 同步（-NoProfileSync）'
} elseif (-not $effectiveUser) {
    SayWarn '未识别出用户名，profile 未改动。'
} else {
    $sync = Sync-ProfileUsername -UserName $effectiveUser
    if ($sync.Changed.Count -gt 0) {
        foreach ($c in $sync.Changed) { SayOk "已更新: $c" }
        SayWarn '用户名变了 —— 需要重启 DSH 才会生效（凭据文件本身即时生效）。'
    } elseif ($sync.Skipped.Count -gt 0) {
        foreach ($s in $sync.Skipped) { SayNote "无需改动: $s" }
    } else {
        SayNote "profile 里没有 KAGGLE_RVC_USERNAME 行（$($sync.Root)），未改动。"
    }
}

Say ''
Say '------------------------------------------------------------'
Say '  完成。下一步：'
Say '   1. 回到 DSH，让助手执行 kaggle status —— 应显示账号与 api ping OK；'
Say '   2. 若上面提示「用户名变了」，重启 DSH（凭据文件无需重启即生效）；'
Say '   3. 需要换密钥时，重新运行本脚本即可（会自动清理旧凭据）。'
Say '------------------------------------------------------------'
exit 0
