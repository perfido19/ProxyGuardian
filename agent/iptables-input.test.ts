import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInputChain, findGenericEstablished, findFirstAccept8880, findTorRules, planTorRules, planEstablishedRule } from "./iptables-input";

// dragon (100.116.113.227): ESTABLISHED generica a 9, wt0 a 15, ACCEPT 8880 a 18, DROP wt0 a 19
const DRAGON = `Chain INPUT (policy ACCEPT 1275 packets, 83247 bytes)
num   pkts bytes target     prot opt in     out     source               destination         
1     183K   10M f2b-xtream  tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            multiport dports 8880,8000,2096
7    1985K 2037M ANTI_IPTV  all  --  *      *       0.0.0.0/0            0.0.0.0/0           
8     641K  962M NETBIRD-ACL-INPUT  all  --  wt0    *       0.0.0.0/0            0.0.0.0/0           
9    1810K 2025M ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
15       0     0 ACCEPT     all  --  wt0    *       0.0.0.0/0            0.0.0.0/0            ctstate RELATED,ESTABLISHED
16    8809  457K LOG        all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src limit: avg 10/min burst 20 LOG flags 0 level 4 prefix "[ASN-BLOCK] "
17   27906 1446K DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src
18    5941  361K ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880
19       0     0 DROP       all  --  wt0    *       0.0.0.0/0            0.0.0.0/0`;

// Smarters (100.116.14.174): SOLO ESTABLISHED wt0 a 6 — nessuna generica
const SMARTERS = `Chain INPUT (policy ACCEPT 119K packets, 129M bytes)
num   pkts bytes target     prot opt in     out     source               destination         
5    60418 3843K f2b-sshd   tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            multiport dports 22
6      15M   19G ACCEPT     all  --  wt0    *       0.0.0.0/0            0.0.0.0/0            ctstate RELATED,ESTABLISHED
7    15674  940K NETBIRD-ACL-INPUT  all  --  wt0    *       0.0.0.0/0            0.0.0.0/0           
8       23   932 DROP       all  --  wt0    *       0.0.0.0/0            0.0.0.0/0           
11    474K   25M DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src
12   5067K  342M ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880`;

test("parseInputChain salta le 2 righe di intestazione e legge num/target/iface", () => {
  const r = parseInputChain(DRAGON);
  assert.equal(r[0].num, 1);
  assert.equal(r[0].target, "f2b-xtream");
  assert.equal(r[0].iface, "*");
  const wt0 = r.find(x => x.num === 8);
  assert.equal(wt0!.iface, "wt0");
});

test("findGenericEstablished ignora le regole scoped a wt0", () => {
  assert.equal(findGenericEstablished(parseInputChain(DRAGON)), 9);
  assert.equal(findGenericEstablished(parseInputChain(SMARTERS)), null);
});

test("findFirstAccept8880 trova la ACCEPT sulla porta proxy", () => {
  assert.equal(findFirstAccept8880(parseInputChain(DRAGON)), 18);
  assert.equal(findFirstAccept8880(parseInputChain(SMARTERS)), 12);
});

test("findTorRules su catena senza regole Tor ritorna null", () => {
  assert.deepEqual(findTorRules(parseInputChain(DRAGON)), { log: null, drop: null });
});

test("planTorRules rifiuta se manca la ESTABLISHED generica", () => {
  const p = planTorRules(parseInputChain(SMARTERS));
  assert.equal(p.action, "refuse");
  assert.match(p.reason!, /RELATED,ESTABLISHED/);
});

test("planTorRules su dragon inserisce subito dopo l'ancora generica", () => {
  const p = planTorRules(parseInputChain(DRAGON));
  assert.equal(p.action, "insert");
  assert.equal(p.anchor, 9);
  assert.equal(p.insertAt, 10);
});

test("planTorRules rifiuta se ACCEPT 8880 sta sopra l'ancora", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880
2        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED`;
  const p = planTorRules(parseInputChain(chain));
  assert.equal(p.action, "refuse");
  assert.match(p.reason!, /8880/);
});

test("planTorRules e' noop se le regole Tor sono gia' nella finestra corretta", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
2        0     0 LOG        all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src limit: avg 10/min burst 20 LOG flags 0 level 4 prefix "[TOR-BLOCK] "
3        0     0 DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src
4        0     0 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880`;
  assert.equal(planTorRules(parseInputChain(chain)).action, "noop");
});

test("planTorRules riposiziona se le regole Tor stanno sotto l'ACCEPT 8880", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
2        0     0 ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880
3        0     0 LOG        all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src limit: avg 10/min burst 20 LOG flags 0 level 4 prefix "[TOR-BLOCK] "
4        0     0 DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set tor_exit src`;
  assert.equal(planTorRules(parseInputChain(chain)).action, "reposition");
});

// Caso reale trovato il 2026-08-04 su Raffaele+ Franco: la ESTABLISHED esisteva
// (posizione 12) ma stava SOTTO il DROP blocked_asn (posizione 8), quindi curl a
// packagecloud.io andava in timeout. Il controllo di sola presenza non lo vedeva.
const EST_SOTTO_ASN = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
7     1104 58815 LOG        all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src limit: avg 10/min burst 20 LOG flags 0 level 4 prefix "[ASN-BLOCK] "
8     8305  437K DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src
10   20024 1081K ACCEPT     tcp  --  *      *       0.0.0.0/0            0.0.0.0/0            tcp dpt:8880
12    218K  193M ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED`;

test("planEstablishedRule riposiziona se la EST sta sotto un DROP su ipset", () => {
  const p = planEstablishedRule(parseInputChain(EST_SOTTO_ASN));
  assert.equal(p.action, "reposition");
  assert.equal(p.position, 12);
  assert.equal(p.blockedBy, 8);
});

test("planEstablishedRule e' noop se la EST sta sopra i DROP su ipset", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
2        0     0 DROP       all  --  *      *       0.0.0.0/0            0.0.0.0/0            match-set blocked_asn src`;
  const p = planEstablishedRule(parseInputChain(chain));
  assert.equal(p.action, "noop");
  assert.equal(p.position, 1);
});

test("planEstablishedRule chiede l'inserimento se la EST generica manca", () => {
  assert.equal(planEstablishedRule(parseInputChain(SMARTERS)).action, "insert");
});

test("planEstablishedRule ignora i DROP scoped a wt0 senza match-set", () => {
  const chain = `Chain INPUT (policy ACCEPT)
num   pkts bytes target     prot opt in     out     source               destination         
1        0     0 DROP       all  --  wt0    *       0.0.0.0/0            0.0.0.0/0           
2        0     0 ACCEPT     all  --  *      *       0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED`;
  assert.equal(planEstablishedRule(parseInputChain(chain)).action, "noop");
});
