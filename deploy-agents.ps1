$plink = 'C:\Program Files\PuTTY\plink.exe'
$cmd = 'curl -fsSL https://raw.githubusercontent.com/perfido19/ProxyGuardian/main/agent/update.sh | sudo bash'

$job1 = Start-Job -ScriptBlock {
  param($p, $c)
  & $p -batch -pw 'eQrF1g8a99' -hostkey 'SHA256:WoSUQSa01uwEFA6rgElc9Ply7tU/sysDE2Hj8xN/DO4' root@145.223.69.228 $c 2>&1
} -ArgumentList $plink, $cmd

$job2 = Start-Job -ScriptBlock {
  param($p, $c)
  & $p -batch -pw 'RSbcp91Iv002lipQT5' -hostkey 'SHA256:r0cMCsBrcVcNsiLh+74cVDWoGT0CfhsY4NnGnaQDCEI' root@176.125.242.101 $c 2>&1
} -ArgumentList $plink, $cmd

Wait-Job -Job $job1, $job2 | Out-Null

Write-Host '=== Prova Neutrale (145.223.69.228) ==='
Receive-Job $job1

Write-Host ''
Write-Host '=== Secucam (176.125.242.101) ==='
Receive-Job $job2
