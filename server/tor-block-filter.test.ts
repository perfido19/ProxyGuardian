import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidIpv4, parseTorList, validateTorList, parseWhitelist, filterTorList } from "./tor-block-filter";

test("isValidIpv4 accetta indirizzi validi", () => {
  assert.equal(isValidIpv4("8.8.8.8"), true);
  assert.equal(isValidIpv4("255.255.255.255"), true);
});

test("isValidIpv4 rifiuta ottetti fuori range, forme incomplete e zero-padding", () => {
  assert.equal(isValidIpv4("256.1.1.1"), false);
  assert.equal(isValidIpv4("1.2.3"), false);
  assert.equal(isValidIpv4("01.2.3.4"), false);
  assert.equal(isValidIpv4("1.2.3.4.5"), false);
  assert.equal(isValidIpv4(""), false);
});

test("parseTorList scarta commenti, righe vuote e voci non valide", () => {
  const body = "# commento\n\n8.8.8.8\n  1.1.1.1  \nnon-un-ip\n999.1.1.1\n";
  assert.deepEqual(parseTorList(body), ["8.8.8.8", "1.1.1.1"]);
});

test("validateTorList rifiuta liste sotto il minimo", () => {
  const r = validateTorList(["1.1.1.1"], 0);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /minimo/);
});

test("validateTorList rifiuta un crollo oltre il 50% rispetto al conteggio precedente", () => {
  const ips = Array.from({ length: 100 }, (_, i) => `10.0.0.${i}`);
  assert.equal(validateTorList(ips, 300).ok, false);
  assert.equal(validateTorList(ips, 150).ok, true);
});

test("validateTorList accetta la prima lista quando non c'e' un precedente", () => {
  const ips = Array.from({ length: 60 }, (_, i) => `10.0.0.${i}`);
  assert.equal(validateTorList(ips, 0).ok, true);
});

test("parseWhitelist separa prefissi e domini ignorando i commenti", () => {
  const content = "# testata\n85.9.200.0/21   # netbird\ndomain:api.netbird.io # api\ndomain:*.wild.io\n\n1.2.3.4\n";
  const r = parseWhitelist(content);
  assert.deepEqual(r.cidrs, ["85.9.200.0/21", "1.2.3.4"]);
  assert.deepEqual(r.domains, ["api.netbird.io"]);
});

// Il 2026-07-08 l'IP della dashboard e' finito nell'ipset iptv_ban su 52 VPS su 54,
// causando mesi di instabilita' NetBird attribuita ad altro. Questo test e' la rete
// di sicurezza contro la ripetizione dello stesso incidente su tor_exit.
test("filterTorList rimuove SEMPRE la mesh NetBird, la dashboard e il main backend", () => {
  const input = ["100.116.132.180", "100.64.0.1", "100.127.255.254", "185.229.236.50", "80.244.4.35", "8.8.8.8"];
  const r = filterTorList(input);
  assert.deepEqual(r.ips, ["8.8.8.8"]);
  assert.equal(r.removed.length, 5);
});

test("filterTorList non tocca IP appena fuori dal range NetBird", () => {
  const r = filterTorList(["100.63.255.255", "100.128.0.0"]);
  assert.deepEqual(r.ips, ["100.63.255.255", "100.128.0.0"]);
});

test("filterTorList applica anche la whitelist aggiuntiva", () => {
  const r = filterTorList(["1.2.3.4", "9.9.9.9"], ["1.2.3.0/24"]);
  assert.deepEqual(r.ips, ["9.9.9.9"]);
  assert.deepEqual(r.removed, ["1.2.3.4"]);
});

test("filterTorList ignora le voci di whitelist malformate senza esplodere", () => {
  const r = filterTorList(["1.2.3.4"], ["non-un-cidr", "1.2.3.0/99", ""]);
  assert.deepEqual(r.ips, ["1.2.3.4"]);
});
