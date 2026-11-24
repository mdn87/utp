# Cross-shell Tier A lifecycle driver for PowerShell 7 (pwsh).
# Exact scenario-for-scenario twin of lifecycle.sh producing the same normalized records.
param(
  [Parameter(Mandatory)][string]$NodeBin,
  [Parameter(Mandatory)][string]$UtpCli,
  [Parameter(Mandatory)][string]$Helper,
  [Parameter(Mandatory)][string]$WorkDir,
  [Parameter(Mandatory)][string]$LogFile,
  [Parameter(Mandatory)][string]$ServerUrl,
  [Parameter(Mandatory)][string]$ControlUrl,
  [Parameter(Mandatory)][string]$UnusedUrl,
  [Parameter(Mandatory)][string]$VerifiedToken,
  [Parameter(Mandatory)][string]$RemoteToken,
  [Parameter(Mandatory)][string]$SessionClaude,
  [Parameter(Mandatory)][string]$SessionCodex,
  [Parameter(Mandatory)][string]$SessionWrong,
  [Parameter(Mandatory)][string]$ExpiresAt
)

$ErrorActionPreference = "Stop"

$Fix = Join-Path $WorkDir "fixtures with spaces"
$Repo = Join-Path $WorkDir "repo with spaces"
$HomeMain = Join-Path $WorkDir "home main"
$HomeRemote = Join-Path $WorkDir "home remote"
$OutFile = Join-Path $WorkDir "last out.txt"
$ErrFile = Join-Path $WorkDir "last err.txt"
New-Item -ItemType Directory -Force -Path $Fix, $Repo, $HomeMain, $HomeRemote | Out-Null
Set-Content -Path $LogFile -Value "" -NoNewline -Encoding utf8NoBOM

& git -C $Repo init -q
if ($LASTEXITCODE -ne 0) { throw "git init failed" }
Set-Content -Path (Join-Path $Repo "target.txt") -Value "initial`n" -NoNewline -Encoding utf8NoBOM
Set-Content -Path (Join-Path $Repo "pair.txt") -Value "item-1`nitem-2`n" -NoNewline -Encoding utf8NoBOM

& $NodeBin $Helper write-fixtures $Fix $ExpiresAt
if ($LASTEXITCODE -ne 0) { throw "write-fixtures failed" }

$script:RC = 0

function Run-Utp {
  param([string[]]$UtpArgs)
  Push-Location $Repo
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $NodeBin $UtpCli @UtpArgs 1> $OutFile 2> $ErrFile
    $script:RC = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
    Pop-Location
  }
}

function Run-UtpStdin {
  param([string]$StdinFile, [string[]]$UtpArgs)
  Push-Location $Repo
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    Get-Content -Raw -Path $StdinFile | & $NodeBin $UtpCli @UtpArgs 1> $OutFile 2> $ErrFile
    $script:RC = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
    Pop-Location
  }
}

function JGet {
  param([string]$Field)
  $raw = [System.IO.File]::ReadAllText($OutFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  if (-not $raw.Trim()) { return "" }
  $cur = $raw | ConvertFrom-Json -AsHashtable
  foreach ($part in $Field.Split(".")) {
    if ($null -eq $cur -or -not ($cur -is [System.Collections.IDictionary]) -or -not $cur.Contains($part)) { return "" }
    $cur = $cur[$part]
  }
  if ($null -eq $cur) { return "" }
  if ($cur -is [bool]) { return $cur.ToString().ToLowerInvariant() }
  return [string]$cur
}

function Rec {
  param([string]$Scenario, [string]$Step, [int]$Code, [string]$Detail = "")
  $row = [ordered]@{ scenario = $Scenario; step = $Step; code = $Code }
  if ($Detail) { $row["detail"] = $Detail }
  $line = ($row | ConvertTo-Json -Compress) + "`n"
  [System.IO.File]::AppendAllText($LogFile, $line, (New-Object System.Text.UTF8Encoding($false)))
}

function HasText {
  param([string]$File, [string]$Needle)
  $text = [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
  if ($text.Contains($Needle)) { return "yes" }
  return "no"
}

$VerifiedTokFile = Join-Path $Fix "verified.tok"
$RemoteTokFile = Join-Path $Fix "remote.tok"
Set-Content -Path $VerifiedTokFile -Value "$VerifiedToken`n" -NoNewline -Encoding utf8NoBOM
Set-Content -Path $RemoteTokFile -Value "$RemoteToken`n" -NoNewline -Encoding utf8NoBOM

$env:UTP_HOME = $HomeMain
$env:UTP_SESSION = "session-a"
Remove-Item Env:UTP_SERVER -ErrorAction SilentlyContinue
Remove-Item Env:UTP_PROJECT -ErrorAction SilentlyContinue

Run-UtpStdin $VerifiedTokFile @("connect", $ServerUrl)
Rec "setup" "connect-main" $script:RC
Run-Utp @("init", "--json")
Rec "setup" "init-main" $script:RC
$ProjectId = JGet "project"

$env:UTP_HOME = $HomeRemote
Run-UtpStdin $RemoteTokFile @("connect", $ServerUrl)
Rec "setup" "connect-remote" $script:RC
Run-Utp @("link", $ProjectId, "--json")
Rec "setup" "link-remote" $script:RC

$env:UTP_HOME = $HomeMain
$env:UTP_SESSION = "session-a"

# ---------------------------------------------------------------------------
# Scenario 1: Full ask-to-applied, authority reuse, independent work & ordering
# ---------------------------------------------------------------------------
Run-Utp @("consider", (Join-Path $Fix "consider-routine.json"), "--json")
Rec "s1-lifecycle" "consider-routine" $script:RC "level=$(JGet 'level')"

Run-Utp @("decide", (Join-Path $Fix "consider-routine.json"), "--json")
Rec "s1-lifecycle" "decide-routine" $script:RC "count=$(JGet 'count')"

Run-Utp @("decide", (Join-Path $Fix "decide-choose.json"), "--json")
Rec "s1-lifecycle" "decide-choose" $script:RC "rev=$(JGet 'revision')"
$S1Id = JGet "id"

Set-Content -Path (Join-Path $Repo "independent.txt") -Value "independent work complete`n" -NoNewline -Encoding utf8NoBOM

Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
Rec "s1-lifecycle" "flush" $script:RC "route=$(JGet 'route')"
$S1Review = JGet "review_id"

Run-Utp @("wait", $S1Id, "--json")
Rec "s1-lifecycle" "wait-before-answer" $script:RC "status=$(JGet 'status')"

Run-Utp @("presented", $S1Review, "--channel", "conversation", "--json")
Rec "s1-lifecycle" "presented" $script:RC

Run-Utp @("answer", "$S1Id@1", "--option", "a", "--json")
Rec "s1-lifecycle" "answer" $script:RC "val=$(JGet 'answer.value')"

$AuthFile = Join-Path $Fix "authority.json"
& $NodeBin $Helper write-authority $AuthFile "$S1Id@1"
Run-Utp @("consider", $AuthFile, "--json")
Rec "s1-lifecycle" "consider-authority" $script:RC "level=$(JGet 'level')"

Run-Utp @("wait", "$S1Id@1", "--authority-file", $AuthFile, "--json")
Rec "s1-lifecycle" "wait-with-authority" $script:RC "status=$(JGet 'status')"
$S1Grant = JGet "grant.id"

Run-Utp @("applied", $S1Grant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s1-lifecycle" "applied-before-begin" $script:RC

Run-Utp @("begin", $S1Grant, "--json")
Rec "s1-lifecycle" "begin" $script:RC

Set-Content -Path (Join-Path $Repo "target.txt") -Value "applied-s1`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("applied", $S1Grant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s1-lifecycle" "applied" $script:RC "status=$(JGet 'status')"

# ---------------------------------------------------------------------------
# Scenario 2: Clarification loop (exit 21 -> revise same request -> rev 2)
# ---------------------------------------------------------------------------
Run-Utp @("ask", (Join-Path $Fix "card-clarify.json"), "--json")
Rec "s2-clarify" "ask" $script:RC "rev=$(JGet 'revision')"
$S2Id = JGet "id"

Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
Rec "s2-clarify" "flush-1" $script:RC
$S2Rev1 = JGet "review_id"

Run-Utp @("presented", $S2Rev1, "--channel", "conversation", "--json")
Rec "s2-clarify" "presented-1" $script:RC

Run-Utp @("answer", "$S2Id@1", "--clarify", "--file", (Join-Path $Fix "clarify-answer.json"), "--json")
Rec "s2-clarify" "request-clarify" $script:RC

Run-Utp @("wait", $S2Id, "--json")
Rec "s2-clarify" "wait-clarify" $script:RC "has_note=$(HasText $OutFile '日本語')"

Run-Utp @("revise", $S2Id, (Join-Path $Fix "card-clarify-v2.json"), "--json")
Rec "s2-clarify" "revise" $script:RC "rev=$(JGet 'revision')"

Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
Rec "s2-clarify" "flush-2" $script:RC
$S2Rev2 = JGet "review_id"

Run-Utp @("presented", $S2Rev2, "--channel", "conversation", "--json")
Rec "s2-clarify" "presented-2" $script:RC

Run-Utp @("answer", "$S2Id@2", "--option", "a", "--json")
Rec "s2-clarify" "answer-v2" $script:RC "rev=$(JGet 'revision')"

Run-Utp @("wait", $S2Id, "--json")
Rec "s2-clarify" "wait-v2" $script:RC "rev=$(JGet 'revision')"
$S2Grant = JGet "grant.id"

Run-Utp @("begin", $S2Grant, "--json")
Rec "s2-clarify" "begin" $script:RC

Run-Utp @("applied", $S2Grant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s2-clarify" "applied" $script:RC "status=$(JGet 'status')"

# ---------------------------------------------------------------------------
# Scenario 3: Level-2 eligible defaults & all D4 late-answer branches
# ---------------------------------------------------------------------------
# 3a: Clean default
Run-Utp @("ask", (Join-Path $Fix "card-default.json"), "--json")
$S3aId = JGet "id"
Run-Utp @("flush", "--json")
$S3aRev = JGet "review_id"
Run-Utp @("presented", $S3aRev, "--channel", "conversation", "--json")
Run-Utp @("claim-default", $S3aId, "--json")
Rec "s3a-default-clean" "claim-default" $script:RC "status=$(JGet 'status')"
$S3aGrant = JGet "grant.id"
Run-Utp @("begin", $S3aGrant, "--json")
Rec "s3a-default-clean" "begin" $script:RC
Set-Content -Path (Join-Path $Repo "target.txt") -Value "default-3a`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("applied", $S3aGrant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s3a-default-clean" "applied" $script:RC "status=$(JGet 'status')"

# 3b-i: Late answer BEFORE claim-default -> 16
Run-Utp @("ask", (Join-Path $Fix "card-default.json"), "--json")
$S3b1Id = JGet "id"
Run-Utp @("flush", "--json")
$S3b1Rev = JGet "review_id"
Run-Utp @("presented", $S3b1Rev, "--channel", "conversation", "--json")
Run-Utp @("answer", "$S3b1Id@1", "--option", "b", "--json")
Run-Utp @("claim-default", $S3b1Id, "--json")
Rec "s3b-late-before-begin" "claim-after-answer" $script:RC
Run-Utp @("wait", $S3b1Id, "--json")
Rec "s3b-late-before-begin" "wait-after-16" $script:RC "val=$(JGet 'answer.value')"
$S3b1Grant = JGet "grant.id"
Run-Utp @("begin", $S3b1Grant, "--json")
Run-Utp @("applied", $S3b1Grant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s3b-late-before-begin" "applied-after-16" $script:RC "status=$(JGet 'status')"

# 3b-ii: Late answer AFTER claim-default, BEFORE begin -> 17
Run-Utp @("ask", (Join-Path $Fix "card-default.json"), "--json")
$S3b2Id = JGet "id"
Run-Utp @("flush", "--json")
$S3b2Rev = JGet "review_id"
Run-Utp @("presented", $S3b2Rev, "--channel", "conversation", "--json")
Run-Utp @("claim-default", $S3b2Id, "--json")
Rec "s3b-late-before-begin" "claim-default" $script:RC
$S3b2DefGrant = JGet "grant.id"
Run-Utp @("answer", "$S3b2Id@1", "--option", "b", "--json")
Run-Utp @("begin", $S3b2DefGrant, "--json")
Rec "s3b-late-before-begin" "begin-revoked" $script:RC
Run-Utp @("wait", $S3b2Id, "--json")
Rec "s3b-late-before-begin" "wait-new-grant" $script:RC "val=$(JGet 'answer.value')"
$S3b2Grant = JGet "grant.id"
Run-Utp @("begin", $S3b2Grant, "--json")
Rec "s3b-late-before-begin" "begin-answer-grant" $script:RC
Run-Utp @("applied", $S3b2Grant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s3b-late-before-begin" "applied-answer-grant" $script:RC "status=$(JGet 'status')"

# 3c: Late contradicting answer DURING executing -> applied exits 14
Run-Utp @("ask", (Join-Path $Fix "card-default.json"), "--json")
$S3cId = JGet "id"
Run-Utp @("flush", "--json")
$S3cRev = JGet "review_id"
Run-Utp @("presented", $S3cRev, "--channel", "conversation", "--json")
Run-Utp @("claim-default", $S3cId, "--json")
$S3cGrant = JGet "grant.id"
Run-Utp @("begin", $S3cGrant, "--json")
Rec "s3c-late-during-exec" "begin" $script:RC
Run-Utp @("answer", "$S3cId@1", "--option", "b", "--json")
Rec "s3c-late-during-exec" "answer-during-exec" $script:RC
Set-Content -Path (Join-Path $Repo "target.txt") -Value "default-3c`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("applied", $S3cGrant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s3c-late-during-exec" "applied-conflict" $script:RC "status=$(JGet 'status')"
Run-Utp @("resolve-late", $S3cId, "--resolution", "keep", "--json")
Rec "s3c-late-during-exec" "resolve-keep" $script:RC "status=$(JGet 'status')"

# 3d-keep: Late contradicting answer AFTER applied -> wait 14 -> keep
Run-Utp @("ask", (Join-Path $Fix "card-default.json"), "--json")
$S3dkId = JGet "id"
Run-Utp @("flush", "--json")
$S3dkRev = JGet "review_id"
Run-Utp @("presented", $S3dkRev, "--channel", "conversation", "--json")
Run-Utp @("claim-default", $S3dkId, "--json")
$S3dkGrant = JGet "grant.id"
Run-Utp @("begin", $S3dkGrant, "--json")
Set-Content -Path (Join-Path $Repo "target.txt") -Value "default-3dk`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("applied", $S3dkGrant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Run-Utp @("answer", "$S3dkId@1", "--option", "b", "--json")
Run-Utp @("wait", $S3dkId, "--json")
Rec "s3d-late-after-applied" "keep-wait-conflict" $script:RC
Run-Utp @("resolve-late", $S3dkId, "--resolution", "keep", "--json")
Rec "s3d-late-after-applied" "resolve-keep" $script:RC "status=$(JGet 'status');grant=$(JGet 'grant.id')"

# 3d-redo: Late contradicting answer AFTER applied -> wait 14 -> redo
Run-Utp @("ask", (Join-Path $Fix "card-default.json"), "--json")
$S3drId = JGet "id"
Run-Utp @("flush", "--json")
$S3drRev = JGet "review_id"
Run-Utp @("presented", $S3drRev, "--channel", "conversation", "--json")
Run-Utp @("claim-default", $S3drId, "--json")
$S3drGrant = JGet "grant.id"
Run-Utp @("begin", $S3drGrant, "--json")
Set-Content -Path (Join-Path $Repo "target.txt") -Value "default-3dr`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("applied", $S3drGrant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Run-Utp @("answer", "$S3drId@1", "--option", "b", "--json")
Run-Utp @("wait", $S3drId, "--json")
Rec "s3d-late-after-applied" "redo-wait-conflict" $script:RC
Run-Utp @("resolve-late", $S3drId, "--resolution", "redo", "--json")
Rec "s3d-late-after-applied" "resolve-redo" $script:RC "opt=$(JGet 'grant.option')"
$S3drRedoGrant = JGet "grant.id"
Run-Utp @("begin", $S3drRedoGrant, "--json")
Rec "s3d-late-after-applied" "redo-begin" $script:RC
Set-Content -Path (Join-Path $Repo "target.txt") -Value "redo-3dr`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("applied", $S3drRedoGrant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s3d-late-after-applied" "redo-applied" $script:RC "status=$(JGet 'status')"

# ---------------------------------------------------------------------------
# Scenario 4: Cancel, stale basis/rev, expiry, reconcile, release, takeover
# ---------------------------------------------------------------------------
Run-Utp @("ask", (Join-Path $Fix "card-clarify.json"), "--json")
$S4aId = JGet "id"
Run-Utp @("flush", "--json")
$S4aRev = JGet "review_id"
Run-Utp @("presented", $S4aRev, "--channel", "conversation", "--json")
Run-Utp @("cancel", $S4aId, "--json")
Rec "s4-recovery" "cancel" $script:RC "status=$(JGet 'status')"
Run-Utp @("wait", $S4aId, "--json")
Rec "s4-recovery" "wait-cancelled" $script:RC

Run-Utp @("ask", (Join-Path $Fix "card-clarify.json"), "--json")
$S4bId = JGet "id"
Run-Utp @("flush", "--json")
$S4bRev = JGet "review_id"
Run-Utp @("presented", $S4bRev, "--channel", "conversation", "--json")
Run-Utp @("answer", "$S4bId@1", "--option", "a", "--json")
Run-Utp @("wait", $S4bId, "--json")
$S4bGrant = JGet "grant.id"
Set-Content -Path (Join-Path $Repo "target.txt") -Value "changed-basis`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("begin", $S4bGrant, "--json")
Rec "s4-recovery" "stale-basis-begin" $script:RC
Run-Utp @("revise", $S4bId, (Join-Path $Fix "card-clarify-v2.json"), "--json")
Run-Utp @("answer", "$S4bId@1", "--option", "a", "--json")
Rec "s4-recovery" "stale-rev-answer" $script:RC
Run-Utp @("cancel", $S4bId, "--json")

Run-Utp @("ask", (Join-Path $Fix "card-expire.json"), "--json")
$S4cId = JGet "id"
Run-Utp @("flush", "--json")
$S4cRev = JGet "review_id"
Run-Utp @("presented", $S4cRev, "--channel", "conversation", "--json")
& $NodeBin $Helper advance $ControlUrl 600000
Run-Utp @("wait", $S4cId, "--json")
Rec "s4-recovery" "wait-expired" $script:RC

Run-Utp @("ask", (Join-Path $Fix "card-clarify.json"), "--json")
$S4dId = JGet "id"
Run-Utp @("flush", "--json")
$S4dRev = JGet "review_id"
Run-Utp @("presented", $S4dRev, "--channel", "conversation", "--json")
Run-Utp @("answer", "$S4dId@1", "--option", "a", "--json")
Run-Utp @("wait", $S4dId, "--json")
$S4dG1 = JGet "grant.id"
Run-Utp @("release", $S4dG1, "--json")
Rec "s4-recovery" "release" $script:RC "status=$(JGet 'status')"
Run-Utp @("wait", $S4dId, "--json")
$S4dG2 = JGet "grant.id"
Run-Utp @("begin", $S4dG2, "--json")
& $NodeBin $Helper advance $ControlUrl 90000000
Run-Utp @("wait", $S4dId, "--json")
Rec "s4-recovery" "wait-outcome-unknown" $script:RC
Run-Utp @("reconcile", $S4dG2, "--outcome", "not-performed", "--evidence", (Join-Path $Fix "evidence-not-performed.json"), "--json")
Rec "s4-recovery" "reconcile-not-performed" $script:RC "status=$(JGet 'status')"
Run-Utp @("wait", $S4dId, "--json")
$S4dG3 = JGet "grant.id"
Run-Utp @("begin", $S4dG3, "--json")
Run-Utp @("applied", $S4dG3, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s4-recovery" "applied-after-reconcile" $script:RC "status=$(JGet 'status')"

Run-Utp @("ask", (Join-Path $Fix "card-partial.json"), "--json")
$S4eId = JGet "id"
Run-Utp @("flush", "--json")
$S4eRev = JGet "review_id"
Run-Utp @("presented", $S4eRev, "--channel", "conversation", "--json")
Run-Utp @("answer", "$S4eId@1", "--option", "a", "--json")
Run-Utp @("wait", $S4eId, "--json")
$S4eG1 = JGet "grant.id"
Run-Utp @("begin", $S4eG1, "--json")
Set-Content -Path (Join-Path $Repo "pair.txt") -Value "item-1-done`nitem-2`n" -NoNewline -Encoding utf8NoBOM
& $NodeBin $Helper advance $ControlUrl 90000000
Run-Utp @("reconcile", $S4eG1, "--outcome", "partial", "--evidence", (Join-Path $Fix "evidence-partial.json"), "--json")
Rec "s4-recovery" "reconcile-partial" $script:RC "status=$(JGet 'status')"
Run-Utp @("wait", $S4eId, "--json")
Rec "s4-recovery" "wait-partial-grant" $script:RC "scope=$(JGet 'grant.authorization.scope')"
$S4eG2 = JGet "grant.id"
Run-Utp @("begin", $S4eG2, "--json")
Set-Content -Path (Join-Path $Repo "pair.txt") -Value "item-1-done`nitem-2-done`n" -NoNewline -Encoding utf8NoBOM
Run-Utp @("applied", $S4eG2, "--evidence", (Join-Path $Fix "evidence-partial-finish.json"), "--json")
Rec "s4-recovery" "applied-partial" $script:RC "status=$(JGet 'status')"

$env:UTP_SESSION = "session-a"
Run-Utp @("ask", (Join-Path $Fix "card-clarify.json"), "--json")
$S4fId = JGet "id"
Run-Utp @("flush", "--json")
$S4fRev = JGet "review_id"
Run-Utp @("presented", $S4fRev, "--channel", "conversation", "--json")
Run-Utp @("answer", "$S4fId@1", "--option", "a", "--json")
Run-Utp @("wait", $S4fId, "--json")
$S4fG1 = JGet "grant.id"
& $NodeBin $Helper advance $ControlUrl 1200000
$env:UTP_SESSION = "session-b"
Run-Utp @("takeover", $S4fId, "--json")
Rec "s4-recovery" "takeover" $script:RC "epoch=$(JGet 'epoch')"
$env:UTP_SESSION = "session-a"
Run-Utp @("begin", $S4fG1, "--json")
Rec "s4-recovery" "old-owner-begin-epoch" $script:RC
$env:UTP_SESSION = "session-b"
Run-Utp @("wait", $S4fId, "--json")
$S4fG2 = JGet "grant.id"
Run-Utp @("begin", $S4fG2, "--json")
Run-Utp @("applied", $S4fG2, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s4-recovery" "new-owner-applied" $script:RC "status=$(JGet 'status')"

# ---------------------------------------------------------------------------
# Scenario 5: Provenance & upfront level-3 routing matrix
# ---------------------------------------------------------------------------
Set-Content -Path (Join-Path $Fix "turn-start.txt") -Value "Start release check.`n" -NoNewline -Encoding utf8NoBOM
Set-Content -Path (Join-Path $Fix "turn-yes.txt") -Value "yes`n" -NoNewline -Encoding utf8NoBOM

foreach ($plat in @("claude", "codex")) {
  $env:UTP_HOME = $HomeMain
  $env:UTP_SESSION = if ($plat -eq "claude") { $SessionClaude } else { $SessionCodex }
  & $NodeBin $Helper transcript $ControlUrl $plat $env:UTP_SESSION "user" (Join-Path $Fix "turn-start.txt")

  Run-Utp @("status", "--json")
  Rec "s5-provenance-$plat" "status-capability" $script:RC "chat=$(JGet 'chat_provenance')"

  Run-Utp @("ask", (Join-Path $Fix "card-approve.json"), "--json")
  $S5Id = JGet "id"
  Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
  Rec "s5-provenance-$plat" "flush-verified" $script:RC "route=$(JGet 'route');chat=$(JGet 'chat_provenance')"
  $S5Rev = JGet "review_id"

  Run-Utp @("show", $S5Rev)
  $ShownFile = Join-Path $Fix "shown-$plat.md"
  Copy-Item -Force $OutFile $ShownFile
  & $NodeBin $Helper transcript $ControlUrl $plat $env:UTP_SESSION "assistant" $ShownFile
  Run-Utp @("presented", $S5Rev, "--channel", "conversation", "--json")
  Rec "s5-provenance-$plat" "presented" $script:RC
  $S5Pres = JGet "presentation_id"

  & $NodeBin $Helper transcript $ControlUrl $plat $env:UTP_SESSION "user" (Join-Path $Fix "turn-yes.txt")

  Run-Utp @("answer", "$S5Id@1", "--from-chat", "--presentation", $S5Pres, "--quote-file", (Join-Path $Fix "quote-altered.txt"), "--json")
  Rec "s5-provenance-$plat" "neg-altered-quote" $script:RC

  Run-Utp @("answer", "$S5Id@1", "--from-chat", "--presentation", $S5Pres, "--quote-file", (Join-Path $Fix "quote-partial.txt"), "--json")
  Rec "s5-provenance-$plat" "neg-partial-quote" $script:RC

  $SavedSid = $env:UTP_SESSION
  $env:UTP_SESSION = $SessionWrong
  Run-Utp @("answer", "$S5Id@1", "--from-chat", "--presentation", $S5Pres, "--quote-file", (Join-Path $Fix "quote-exact.txt"), "--json")
  Rec "s5-provenance-$plat" "neg-wrong-session" $script:RC
  $env:UTP_SESSION = $SavedSid

  Run-Utp @("answer", "$S5Id@1", "--from-chat", "--presentation", "P-00000000-00000000", "--quote-file", (Join-Path $Fix "quote-exact.txt"), "--json")
  Rec "s5-provenance-$plat" "neg-wrong-presentation" $script:RC

  Run-Utp @("answer", "$S5Id@1", "--from-chat", "--presentation", $S5Pres, "--quote-file", (Join-Path $Fix "quote-exact.txt"), "--json")
  Rec "s5-provenance-$plat" "pos-chat-answer" $script:RC "verified=$(JGet 'answer.verified')"

  Run-Utp @("wait", $S5Id, "--json")
  Rec "s5-provenance-$plat" "wait-transcript-grant" $script:RC "prov=$(JGet 'grant.provenance')"
  $S5Grant = JGet "grant.id"
  Run-Utp @("begin", $S5Grant, "--json")
  Run-Utp @("applied", $S5Grant, "--evidence", (Join-Path $Fix "evidence-approve.json"), "--json")
  Rec "s5-provenance-$plat" "applied" $script:RC "status=$(JGet 'status')"

  Run-Utp @("ask", (Join-Path $Fix "card-approve.json"), "--json")
  $S5rId = JGet "id"
  Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
  $S5rRev = JGet "review_id"
  Run-Utp @("show", $S5rRev)
  $ShownReuse = Join-Path $Fix "shown-reuse-$plat.md"
  Copy-Item -Force $OutFile $ShownReuse
  & $NodeBin $Helper transcript $ControlUrl $plat $env:UTP_SESSION "assistant" $ShownReuse
  Run-Utp @("presented", $S5rRev, "--channel", "conversation", "--json")
  $S5rPres = JGet "presentation_id"
  Run-Utp @("answer", "$S5rId@1", "--from-chat", "--presentation", $S5rPres, "--quote-file", (Join-Path $Fix "quote-exact.txt"), "--json")
  Rec "s5-provenance-$plat" "neg-reused-quote" $script:RC
  Run-Utp @("cancel", $S5rId, "--json")
}

# 5b: Unverifiable channel (Antigravity / remote host)
$env:UTP_HOME = $HomeRemote
$env:UTP_SESSION = "agy-session-1"
Run-Utp @("status", "--json")
Rec "s5-unverifiable" "status-capability" $script:RC "chat=$(JGet 'chat_provenance')"

Run-Utp @("ask", (Join-Path $Fix "card-approve.json"), "--json")
$S5uId = JGet "id"
Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
$S5uRev = JGet "review_id"
$S5uUrl = JGet "url"
$HasUrl = if ($S5uUrl) { "yes" } else { "no" }
Rec "s5-unverifiable" "flush-upfront-page" $script:RC "route=$(JGet 'route');chat=$(JGet 'chat_provenance');has_url=$HasUrl"

Run-Utp @("ask", (Join-Path $Fix "card-approve.json"), "--json")
$S5u2Id = JGet "id"
Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"))
Rec "s5-unverifiable" "flush-human-no-chat-md" $script:RC "has_md=$(HasText $OutFile '### A.');has_hint=$(HasText $OutFile 'verified chat is unavailable')"
Run-Utp @("cancel", $S5u2Id, "--json")

Run-Utp @("presented", $S5uRev, "--channel", "conversation", "--json")
$S5uPres = JGet "presentation_id"
Run-Utp @("answer", "$S5uId@1", "--from-chat", "--presentation", $S5uPres, "--quote-file", (Join-Path $Fix "quote-exact.txt"), "--json")
Rec "s5-unverifiable" "defensive-from-chat" $script:RC
Run-Utp @("show", $S5uId, "--json")
Rec "s5-unverifiable" "preserved-after-18" $script:RC "status=$(JGet 'request.status');rev=$(JGet 'request.revision')"

$PageHttp = (& $NodeBin $Helper browser-answer $ControlUrl $S5uUrl "yes")
Rec "s5-unverifiable" "page-answer" 0 "http=$PageHttp"
Run-Utp @("wait", $S5uId, "--json")
Rec "s5-unverifiable" "wait-page-grant" $script:RC "prov=$(JGet 'grant.provenance')"
$S5uGrant = JGet "grant.id"
Run-Utp @("begin", $S5uGrant, "--json")
Run-Utp @("applied", $S5uGrant, "--evidence", (Join-Path $Fix "evidence-approve.json"), "--json")
Rec "s5-unverifiable" "applied-page" $script:RC "status=$(JGet 'status')"

# ---------------------------------------------------------------------------
# Scenario 6: Separate-process exit & resume (same-session and new-session)
# ---------------------------------------------------------------------------
$env:UTP_HOME = $HomeMain
$env:UTP_SESSION = "resume-session-1"
Run-Utp @("ask", (Join-Path $Fix "card-clarify.json"), "--json")
$S6aId = JGet "id"
Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
$S6aRev = JGet "review_id"
Run-Utp @("presented", $S6aRev, "--channel", "conversation", "--json")
Run-Utp @("wait", $S6aId, "--json")
Rec "s6-resume" "same-proc-a-blocks" $script:RC

$env:UTP_SESSION = "reviewer-terminal"
Run-Utp @("answer", "$S6aId@1", "--option", "a", "--json")
Rec "s6-resume" "same-proc-b-answers" $script:RC

$env:UTP_SESSION = "resume-session-1"
Run-Utp @("status", "--json")
Rec "s6-resume" "same-proc-a2-status" $script:RC
Run-Utp @("wait", $S6aId, "--json")
Rec "s6-resume" "same-proc-a2-wait" $script:RC "role=$(JGet 'role')"
$S6aGrant = JGet "grant.id"
Run-Utp @("begin", $S6aGrant, "--json")
Run-Utp @("applied", $S6aGrant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s6-resume" "same-proc-a2-applied" $script:RC "status=$(JGet 'status')"

$env:UTP_SESSION = "resume-session-old"
Run-Utp @("ask", (Join-Path $Fix "card-clarify.json"), "--json")
$S6bId = JGet "id"
Run-Utp @("flush", "--intent", (Join-Path $Fix "intent.json"), "--json")
$S6bRev = JGet "review_id"
Run-Utp @("presented", $S6bRev, "--channel", "conversation", "--json")
Run-Utp @("wait", $S6bId, "--json")
Rec "s6-resume" "new-proc-a-blocks" $script:RC

$env:UTP_SESSION = "reviewer-terminal"
Run-Utp @("answer", "$S6bId@1", "--option", "a", "--json")

$env:UTP_SESSION = "resume-session-new"
Run-Utp @("takeover", $S6bId, "--json")
Rec "s6-resume" "new-proc-c-takeover" $script:RC "epoch=$(JGet 'epoch')"
Run-Utp @("wait", $S6bId, "--json")
Rec "s6-resume" "new-proc-c-wait" $script:RC "role=$(JGet 'role')"
$S6bGrant = JGet "grant.id"
Run-Utp @("begin", $S6bGrant, "--json")
Run-Utp @("applied", $S6bGrant, "--evidence", (Join-Path $Fix "evidence-auth.json"), "--json")
Rec "s6-resume" "new-proc-c-applied" $script:RC "status=$(JGet 'status')"

# ---------------------------------------------------------------------------
# Scenario 7: Unreachable service (32) & unset/"default" UTP_SESSION warning
# ---------------------------------------------------------------------------
$env:UTP_HOME = $HomeMain
$env:UTP_SESSION = "session-healthy"
$env:UTP_SERVER = $UnusedUrl
Run-Utp @("status", "--json")
Rec "s7-guards" "unreachable-service" $script:RC
Remove-Item Env:UTP_SERVER -ErrorAction SilentlyContinue

Remove-Item Env:UTP_SESSION -ErrorAction SilentlyContinue
Run-Utp @("status", "--json")
Rec "s7-guards" "warn-unset-session" $script:RC "warn=$(HasText $ErrFile 'UTP_SESSION is unset')"

$env:UTP_SESSION = "default"
Run-Utp @("status", "--json")
Rec "s7-guards" "warn-default-session" $script:RC "warn=$(HasText $ErrFile 'UTP_SESSION is unset')"

$env:UTP_SESSION = "session-unique-ok"
Run-Utp @("status", "--json")
Rec "s7-guards" "quiet-valid-session" $script:RC "warn=$(HasText $ErrFile 'UTP_SESSION is unset')"
