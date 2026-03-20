$plink = 'C:\Program Files\PuTTY\plink.exe'

$job1 = Start-Job -ScriptBlock {
  param($p)
  # Secucam: installa ipset
  & $p -batch -pw 'eQrF1g8a99' -hostkey 'SHA256:WoSUQSa01uwEFA6rgElc9Ply7tU/sysDE2Hj8xN/DO4' root@145.223.69.228 @'
echo "=== Installazione ipset ==="
apt-get install -y ipset ipset-persistent 2>&1
echo "=== Stato dopo installazione ==="
ipset --version
systemctl status ipset-restore --no-pager 2>&1 | head -10
'@ 2>&1
} -ArgumentList $plink

$job2 = Start-Job -ScriptBlock {
  param($p)
  # Prova Neutrale: diagnostica e fix ipset-restore
  & $p -batch -pw 'RSbcp91Iv002lipQT5' -hostkey 'SHA256:r0cMCsBrcVcNsiLh+74cVDWoGT0CfhsY4NnGnaQDCEI' root@176.125.242.101 @'
echo "=== Status ipset-restore ==="
systemctl status ipset-restore --no-pager 2>&1
echo "=== Ultimo errore journalctl ==="
journalctl -u ipset-restore -n 20 --no-pager 2>&1
echo "=== File rules.v4 ==="
ls -lh /etc/iptables/ 2>&1
echo "=== ipset list ==="
ipset list -n 2>&1
'@ 2>&1
} -ArgumentList $plink

Wait-Job -Job $job1, $job2 | Out-Null

Write-Host '=== SECUCAM (installa ipset) ==='
Receive-Job $job1
Write-Host ''
Write-Host '=== PROVA NEUTRALE (diagnostica ipset-restore) ==='
Receive-Job $job2
