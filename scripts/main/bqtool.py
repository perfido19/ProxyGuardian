#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bq - gestione ordine canali nei bouquet XtreamCodes (main DB).

USO:
  bq find <testo>                              cerca stream per nome
  bq where <stream>                            posizione dello stream in ogni bouquet
  bq bouquets                                  elenco bouquet (id, nome, n canali)
  bq show <bouquet> [<stream> | <n1>-<n2>]     finestra canali attorno a stream / range #
  bq check <s1,s2,...>                         ordine relativo di questi canali in ogni bouquet (raggruppa)
  bq move <stream> --after <anchor>  [opts] [--apply]
  bq move <stream> --before <anchor> [opts] [--apply]
  bq add  <stream> --after <anchor>  --bouquets <lista> [--apply]
  bq rm   <stream> --bouquets <lista|all> [--except <ids>] [--apply]

<stream>/<anchor>  = id numerico OPPURE sottostringa nome (deve essere univoca).
opts per move:
  --bouquets 3,73,all        default: tutti i bouquet che contengono lo stream
  --except 81,86             esclude questi id
  --apply                    esegue (senza = dry-run). Fa SEMPRE il dump di backup prima.

Backup automatico: /root/bouquets.bak-YYYYmmdd-HHMMSS.sql
"""
import sys, json, subprocess, time, re

DB = ["mysql", "-u", "root", "xtream_iptvpro"]

def q(sql, tabbed=True):
    args = DB + (["-N", "--batch"] if tabbed else ["--batch"]) + ["-e", sql]
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode("utf-8", "replace")

def qrows(sql):
    out = q(sql)
    return [ln.split("\t") for ln in out.split("\n") if ln.strip()]

def die(m):
    print("ERRORE:", m); sys.exit(1)

def resolve_stream(tok):
    """id o sottostringa nome -> (id, name). Univoco o muore."""
    tok = tok.strip()
    if re.fullmatch(r"\d+", tok):
        r = qrows("SELECT id, stream_display_name FROM streams WHERE id=%s" % int(tok))
        if not r: die("stream id %s inesistente" % tok)
        return r[0][0], r[0][1]
    safe = tok.replace("'", "''")
    r = qrows("SELECT id, stream_display_name FROM streams WHERE stream_display_name LIKE '%%%s%%' ORDER BY added DESC LIMIT 30" % safe)
    if not r:
        die("nessuno stream con nome ~ %r" % tok)
    if len(r) > 1:
        print("AMBIGUO %r -> %d risultati:" % (tok, len(r)))
        for x in r[:15]:
            print("   id=%-7s %s" % (x[0], x[1]))
        die("specifica meglio o usa l'id")
    return r[0][0], r[0][1]

def names_for(ids):
    ids = [str(int(x)) for x in ids if str(x).strip()]
    if not ids: return {}
    d = {}
    for x in qrows("SELECT id, stream_display_name FROM streams WHERE id IN (%s)" % ",".join(ids)):
        if len(x) >= 2: d[x[0]] = x[1]
    return d

def all_bouquets():
    out = []
    for x in qrows("SELECT id, bouquet_name, bouquet_channels FROM bouquets ORDER BY id"):
        if len(x) < 3: continue
        try:
            ch = [str(v) for v in json.loads(x[2])]
        except Exception:
            ch = None
        out.append((x[0], x[1], ch))
    return out

def dump_json(ch):
    s = json.dumps(ch, separators=(",", ":"))
    if not all(c in '0123456789",[]' for c in s):
        die("JSON contiene caratteri inattesi, abort")
    return s

def backup():
    ts = time.strftime("%Y%m%d-%H%M%S")
    path = "/root/bouquets.bak-%s.sql" % ts
    r = subprocess.run(["bash", "-lc", "mysqldump -u root xtream_iptvpro bouquets > %s && wc -c %s" % (path, path)],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode()
    print("BACKUP:", r.strip())
    return path

def parse_bouquet_arg(val, contain_id=None, exc=None):
    exc = set(str(e).strip() for e in (exc or []) if str(e).strip())
    allb = all_bouquets()
    if val in (None, "", "auto"):
        ids = [b[0] for b in allb if b[2] and contain_id in b[2]]
    elif val == "all":
        ids = [b[0] for b in allb if b[2] is not None]
    else:
        ids = [s.strip() for s in val.split(",") if s.strip()]
    return [i for i in ids if i not in exc]

# ---------- commands ----------

def cmd_find(args):
    if not args: die("bq find <testo>")
    safe = " ".join(args).replace("'", "''")
    r = qrows("SELECT id, stream_display_name, FROM_UNIXTIME(added) FROM streams "
              "WHERE stream_display_name LIKE '%%%s%%' ORDER BY added DESC LIMIT 60" % safe)
    if not r: print("nessun risultato"); return
    for x in r:
        print("  id=%-7s  %-50s  %s" % (x[0], x[1], x[2] if len(x) > 2 else ""))

def cmd_bouquets(args):
    for b in all_bouquets():
        n = len(b[2]) if b[2] else "JSON-ERR"
        print("  %-4s %-38s %s" % (b[0], b[1], n))

def cmd_where(args):
    if not args: die("bq where <stream>")
    sid, sname = resolve_stream(args[0])
    print("stream %s = %s\n" % (sid, sname))
    for b in all_bouquets():
        if not b[2] or sid not in b[2]: continue
        i = b[2].index(sid); n = len(b[2])
        nb = names_for(b[2][max(0, i-1):i+2])
        prv = b[2][i-1] if i > 0 else "-"
        nxt = b[2][i+1] if i+1 < n else "-"
        print("  bq %-4s %-30s  #%-6d/%-6d   [%s] <%s> [%s]"
              % (b[0], b[1][:30], i+1, n, nb.get(prv, prv), sname, nb.get(nxt, nxt)))

def cmd_show(args):
    if len(args) < 1: die("bq show <bouquet> [<stream>|<n1>-<n2>]")
    bid = args[0]
    rows = qrows("SELECT bouquet_name, bouquet_channels FROM bouquets WHERE id=%s" % int(bid))
    if not rows: die("bouquet %s inesistente" % bid)
    bn = rows[0][0]; ch = [str(v) for v in json.loads(rows[0][1])]
    n = len(ch)
    if len(args) >= 2 and re.fullmatch(r"\d+-\d+", args[1]):
        a, z = [int(v) for v in args[1].split("-")]
        lo, hi = max(0, a-1), min(n, z)
    elif len(args) >= 2:
        sid, _ = resolve_stream(args[1])
        if sid not in ch: die("stream non nel bouquet")
        i = ch.index(sid); lo, hi = max(0, i-6), min(n, i+7)
    else:
        lo, hi = 0, min(n, 40)
    nb = names_for(ch[lo:hi])
    print("bouquet %s %s  (%d canali)" % (bid, bn, n))
    for k in range(lo, hi):
        print("  #%-6d %-8s %s" % (k+1, ch[k], nb.get(ch[k], "?")))

def cmd_check(args):
    if not args: die("bq check <id1,id2,...>")
    fam = [s.strip() for s in ",".join(args).split(",") if s.strip()]
    fam = [resolve_stream(t)[0] for t in fam]
    nb = names_for(fam)
    groups = {}
    for b in all_bouquets():
        if not b[2]: continue
        seq = tuple(x for x in b[2] if x in fam)
        if not seq: continue
        groups.setdefault(seq, []).append("%s %s" % (b[0], b[1]))
    print("canali: " + " , ".join("%s=%s" % (i, nb.get(i, i)) for i in fam))
    for gi, (seq, bl) in enumerate(groups.items(), 1):
        print("\nGRUPPO %d  (%d bouquet: %s)" % (gi, len(bl), ", ".join(x.split()[0] for x in bl)))
        print("   " + " > ".join(nb.get(x, x) for x in seq))
        for x in bl: print("     - " + x)
    if len(groups) == 1:
        print("\n==> tutti i bouquet hanno lo stesso ordine.")
    else:
        print("\n==> %d ordinamenti diversi (spesso solo per canali presenti/assenti)." % len(groups))

def _do_write(sid, sname, anchor_id, anchor_name, mode, blist, apply_, expect_delta, label):
    """mode: 'after'|'before' (move/add). expect_delta: 0 move, +1 add."""
    print("%s: %s (%s)  %s  %s (%s)" % (label, sname, sid, mode, anchor_name, anchor_id))
    print("bouquet:", ", ".join(blist))
    changed = []
    for b in all_bouquets():
        if b[0] not in blist: continue
        if b[2] is None: print("  bq %s JSON-ERR skip" % b[0]); continue
        ch = list(b[2]); n0 = len(ch)
        present = sid in ch
        if expect_delta == 0 and present:
            ch = [x for x in ch if x != sid]              # move: rimuovi ovunque
        elif expect_delta == 0 and not present:
            print("  bq %-4s: stream non presente, skip (usa 'add')" % b[0]); continue
        elif expect_delta == 1 and present:
            print("  bq %-4s: gia' presente (#%d), skip" % (b[0], ch.index(sid)+1)); continue
        if anchor_id not in ch:
            print("  bq %-4s: anchor assente, skip" % b[0]); continue
        a = ch.index(anchor_id)
        pos = a+1 if mode == "after" else a
        ch.insert(pos, sid)
        exp = n0 + expect_delta
        if len(ch) != exp:
            print("  bq %-4s: len %d->%d atteso %d, SKIP" % (b[0], n0, len(ch), exp)); continue
        j = ch.index(sid)
        nb = names_for(ch[max(0, j-2):j+3])
        win = " | ".join("#%d %s%s" % (k+1, nb.get(ch[k], ch[k]), " <==" if ch[k] == sid else "")
                         for k in range(max(0, j-2), min(len(ch), j+3)))
        print("  bq %-4s n:%d->%d  %s" % (b[0], n0, len(ch), win))
        changed.append((b[0], dump_json(ch)))
    if not changed:
        print("\nniente da fare."); return
    if not apply_:
        print("\n(dry-run: %d bouquet. aggiungi --apply per eseguire)" % len(changed)); return
    backup()
    sql = "\n".join("UPDATE bouquets SET bouquet_channels='%s' WHERE id=%s;" % (j, i) for i, j in changed)
    res = subprocess.run(DB, input=(sql+"\n").encode(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode()
    print("APPLY:", res.strip() or "(ok, %d bouquet aggiornati)" % len(changed))

def cmd_move(args): _move_add(args, expect_delta=0, label="MOVE")
def cmd_add(args):  _move_add(args, expect_delta=1, label="ADD")

def _move_add(args, expect_delta, label):
    if not args: die("bq %s <stream> --after|--before <anchor> [--bouquets ..] [--except ..] [--apply]" % label.lower())
    stream_tok = args[0]
    o = {"after": None, "before": None, "bouquets": None, "except": None, "apply": False}
    it = iter(args[1:])
    for a in it:
        if a in ("--after", "--before", "--bouquets", "--except"):
            o[a[2:]] = next(it)
        elif a == "--apply":
            o["apply"] = True
        else:
            die("arg sconosciuto: %s" % a)
    if not o["after"] and not o["before"]:
        die("serve --after o --before")
    mode = "after" if o["after"] else "before"
    sid, sname = resolve_stream(stream_tok)
    aid, aname = resolve_stream(o["after"] or o["before"])
    exc = (o["except"] or "").split(",") if o["except"] else []
    if expect_delta == 1 and not o["bouquets"]:
        die("per 'add' serve --bouquets (lista o 'all')")
    blist = parse_bouquet_arg(o["bouquets"], contain_id=sid, exc=exc)
    if not blist: die("nessun bouquet selezionato")
    _do_write(sid, sname, aid, aname, mode, blist, o["apply"], expect_delta, label)

def cmd_rm(args):
    if not args: die("bq rm <stream> --bouquets <lista|all> [--except ..] [--apply]")
    sid, sname = resolve_stream(args[0])
    o = {"bouquets": None, "except": None, "apply": False}
    it = iter(args[1:])
    for a in it:
        if a in ("--bouquets", "--except"): o[a[2:]] = next(it)
        elif a == "--apply": o["apply"] = True
        else: die("arg sconosciuto: %s" % a)
    if not o["bouquets"]: die("serve --bouquets")
    exc = (o["except"] or "").split(",") if o["except"] else []
    blist = parse_bouquet_arg(o["bouquets"], contain_id=sid, exc=exc)
    print("RM: %s (%s) da bouquet: %s" % (sname, sid, ", ".join(blist)))
    changed = []
    for b in all_bouquets():
        if b[0] not in blist or not b[2] or sid not in b[2]: continue
        ch = [x for x in b[2] if x != sid]
        print("  bq %-4s n:%d->%d" % (b[0], len(b[2]), len(ch)))
        changed.append((b[0], dump_json(ch)))
    if not changed: print("niente da fare."); return
    if not o["apply"]: print("\n(dry-run; --apply per eseguire)"); return
    backup()
    sql = "\n".join("UPDATE bouquets SET bouquet_channels='%s' WHERE id=%s;" % (j, i) for i, j in changed)
    res = subprocess.run(DB, input=(sql+"\n").encode(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode()
    print("APPLY:", res.strip() or "(ok)")

CMDS = {"find": cmd_find, "where": cmd_where, "bouquets": cmd_bouquets, "show": cmd_show,
        "check": cmd_check, "move": cmd_move, "add": cmd_add, "rm": cmd_rm}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__); sys.exit(0)
    c = sys.argv[1]
    if c not in CMDS: die("comando sconosciuto: %s (bq --help)" % c)
    CMDS[c](sys.argv[2:])
