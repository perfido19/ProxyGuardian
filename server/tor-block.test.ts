import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshTorList, getTorListState, __resetTorStateForTest } from "./tor-block";

const manyIps = (n: number, prefix = "10.0") =>
  Array.from({ length: n }, (_, i) => `${prefix}.${Math.floor(i / 256)}.${i % 256}`).join("\n");

test("refreshTorList popola lo stato con una lista valida", async () => {
  __resetTorStateForTest();
  const s = await refreshTorList(async () => manyIps(100));
  assert.equal(s.count, 100);
  assert.equal(s.lastError, null);
  assert.ok(s.fetchedAt);
});

test("refreshTorList tiene l'ultima lista buona se il fetch fallisce", async () => {
  __resetTorStateForTest();
  await refreshTorList(async () => manyIps(100));
  const s = await refreshTorList(async () => { throw new Error("rete giu'"); });
  assert.equal(s.count, 100, "la lista precedente deve restare");
  assert.match(s.lastError!, /rete giu'/);
});

test("refreshTorList tiene l'ultima lista buona se la nuova crolla oltre il 50%", async () => {
  __resetTorStateForTest();
  await refreshTorList(async () => manyIps(300));
  const s = await refreshTorList(async () => manyIps(100));
  assert.equal(s.count, 300);
  assert.match(s.lastError!, /calo oltre il 50%/);
});

test("refreshTorList rimuove gli IP della mesh NetBird e li conta", async () => {
  __resetTorStateForTest();
  const body = manyIps(100) + "\n100.116.132.180\n185.229.236.50\n";
  const s = await refreshTorList(async () => body);
  assert.equal(s.count, 100);
  assert.equal(s.removedCount, 2);
  assert.ok(!s.ips.includes("100.116.132.180"));
});

test("getTorListState ritorna lo stato corrente senza rifare il fetch", async () => {
  __resetTorStateForTest();
  await refreshTorList(async () => manyIps(80));
  assert.equal(getTorListState().count, 80);
});
