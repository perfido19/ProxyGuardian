// Parsing e pianificazione delle regole della chain INPUT.
// Funzioni pure: nessuna esecuzione di comandi, testabili in isolamento.
//
// IMPORTANTE: l'input deve venire da `iptables -nvL INPUT --line-numbers`.
// `iptables -nL` NON stampa la colonna interfaccia, quindi una regola scoped
// a `-i wt0` (gestita da NetBird) sarebbe indistinguibile da una generica.

export interface InputRule {
  num: number;
  target: string;
  iface: string;
  raw: string;
}

export interface TorRulePlan {
  action: "noop" | "insert" | "reposition" | "refuse";
  reason?: string;
  anchor?: number;
  insertAt?: number;
}

export function parseInputChain(nvlOutput: string): InputRule[] {
  var lines = nvlOutput.split("\n").slice(2);
  var out: InputRule[] = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var f = line.trim().split(/\s+/);
    // num pkts bytes target prot opt in out source destination [extra...]
    if (f.length < 10) continue;
    var num = parseInt(f[0], 10);
    if (isNaN(num)) continue;
    out.push({ num: num, target: f[3], iface: f[6], raw: line });
  }
  return out;
}

function isEstablishedAccept(r: InputRule): boolean {
  return r.target === "ACCEPT" && r.raw.indexOf("RELATED,ESTABLISHED") !== -1;
}

// Solo le regole con interfaccia `*` valgono come ancora: una `-i wt0` copre
// esclusivamente il traffico della mesh NetBird, non quello pubblico.
export function findGenericEstablished(rules: InputRule[]): number | null {
  var found: number | null = null;
  for (var i = 0; i < rules.length; i++) {
    if (isEstablishedAccept(rules[i]) && rules[i].iface === "*") found = rules[i].num;
  }
  return found;
}

export function findFirstAccept8880(rules: InputRule[]): number | null {
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].target === "ACCEPT" && rules[i].raw.indexOf("dpt:8880") !== -1) return rules[i].num;
  }
  return null;
}

export function findTorRules(rules: InputRule[]): { log: number | null; drop: number | null } {
  var log: number | null = null;
  var drop: number | null = null;
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (r.raw.indexOf("match-set tor_exit src") === -1) continue;
    if (r.target === "LOG" && log === null) log = r.num;
    if (r.target === "DROP" && drop === null) drop = r.num;
  }
  return { log: log, drop: drop };
}

// La regola ESTABLISHED non basta che esista: deve stare SOPRA ogni DROP basato su
// ipset, altrimenti il traffico di ritorno delle connessioni in uscita viene droppato
// prima di raggiungerla. Succede davvero: fail2ban inserisce le proprie chain in cima
// e spinge giu' la ESTABLISHED, poi update-asn-block.sh piazza blocked_asn a posizione
// fissa 2/3 verificando solo che la ESTABLISHED *esista* (`iptables -C`), non dove sia.
export interface EstablishedPlan {
  action: "noop" | "insert" | "reposition";
  position: number | null;
  blockedBy: number | null;
}

export function planEstablishedRule(rules: InputRule[]): EstablishedPlan {
  var est = findGenericEstablished(rules);
  if (est === null) return { action: "insert", position: null, blockedBy: null };

  var firstIpsetDrop: number | null = null;
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (r.target === "DROP" && r.raw.indexOf("match-set") !== -1) {
      if (firstIpsetDrop === null || r.num < firstIpsetDrop) firstIpsetDrop = r.num;
    }
  }

  if (firstIpsetDrop !== null && firstIpsetDrop < est) {
    return { action: "reposition", position: est, blockedBy: firstIpsetDrop };
  }
  return { action: "noop", position: est, blockedBy: null };
}

export function planTorRules(rules: InputRule[]): TorRulePlan {
  var anchor = findGenericEstablished(rules);
  if (anchor === null) {
    return {
      action: "refuse",
      reason: "nessuna regola ACCEPT ... RELATED,ESTABLISHED generica (in=*) nella chain INPUT: " +
              "inserire un DROP senza quell'ACCEPT sopra troncherebbe le connessioni gia' stabilite " +
              "e il traffico di ritorno in uscita",
    };
  }

  var accept8880 = findFirstAccept8880(rules);
  if (accept8880 !== null && accept8880 < anchor) {
    return {
      action: "refuse",
      reason: "ACCEPT tcp dpt:8880 in posizione " + accept8880 + ", sopra l'ancora ESTABLISHED (" + anchor +
              "): le regole Tor finirebbero sotto e il traffico verso la porta proxy sarebbe gia' accettato",
    };
  }

  var tor = findTorRules(rules);
  var insertAt = anchor + 1;

  if (tor.log !== null && tor.drop !== null) {
    var ordered = tor.log > anchor && tor.drop > tor.log;
    var beforeProxy = accept8880 === null || tor.drop < accept8880;
    if (ordered && beforeProxy) return { action: "noop", anchor: anchor, insertAt: insertAt };
    return { action: "reposition", anchor: anchor, insertAt: insertAt };
  }

  if (tor.log !== null || tor.drop !== null) {
    // Solo una delle due presenti: stato incoerente, si ricostruisce da zero.
    return { action: "reposition", anchor: anchor, insertAt: insertAt };
  }

  return { action: "insert", anchor: anchor, insertAt: insertAt };
}
