#!/usr/bin/env python3
"""
Construye padron.db (SQLite) desde el Padrón Reducido del RUC de SUNAT.

  python build_padron.py --padron padron_reducido_ruc.txt --ubigeo ubigeo_distrito.csv --out padron.db

- Formato SUNAT: latin-1, separador "|" (con "\\|" escapado dentro de nombres), "-" = vacío, 15 columnas + "|" final.
- Tabla `c`: RUC como INTEGER PRIMARY KEY (búsqueda exacta sin índice extra).
  Se guardan contribuyentes ACTIVO y SUSPENSION TEMPORAL; un RUC que no está es "no activo" para facturar.
- Tabla `c_fts`: búsqueda por razón social (FTS5) solo para personas jurídicas (RUC 20).
- Tabla `ubigeo`: distrito / provincia / departamento (catálogo INEI).
"""
import argparse, csv, os, re, sqlite3, sys, time, unicodedata
from datetime import datetime, timezone

COLS = ["RUC", "NOMBRE O RAZON SOCIAL", "ESTADO DEL CONTRIBUYENTE", "CONDICION DE DOMICILIO", "UBIGEO",
        "TIPO DE VIA", "NOMBRE DE VIA", "CODIGO DE ZONA", "TIPO DE ZONA", "NUMERO", "INTERIOR", "LOTE",
        "DEPARTAMENTO", "MANZANA", "KILOMETRO"]
SPLIT = re.compile(r"(?<!\\)\|")
ESTADOS = {"ACTIVO": "A", "SUSPENSION TEMPORAL": "S"}
WEIGHTS = (5, 4, 3, 2, 7, 6, 5, 4, 3, 2)


def sin_tildes(s):
    return "".join(ch for ch in unicodedata.normalize("NFD", s) if unicodedata.category(ch) != "Mn")


def ruc_ok(r):
    if not re.fullmatch(r"(10|15|16|17|20)\d{9}", r):
        return False
    d = 11 - sum(int(a) * w for a, w in zip(r[:10], WEIGHTS)) % 11
    return {10: 0, 11: 1}.get(d, d) == int(r[10])


def v(x):
    x = x.strip()
    return "" if re.fullmatch(r"-*", x) else x.replace("\\|", "|")


def direccion(f):
    via = " ".join(p for p in (v(f[5]), v(f[6])) if p)
    partes = [via]
    for etq, val in (("NRO.", f[9]), ("INT.", f[10]), ("DPTO.", f[12]), ("MZA.", f[13]), ("LOTE.", f[11]), ("KM.", f[14])):
        if v(val):
            partes.append(f"{etq} {v(val)}")
    zona = " ".join(p for p in (v(f[7]), v(f[8])) if p)
    if zona:
        partes.append(zona)
    return " ".join(p for p in partes if p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--padron", required=True)
    ap.add_argument("--ubigeo", required=True)
    ap.add_argument("--out", default="padron.db")
    ap.add_argument("--fuente-fecha", default="", help="Last-Modified del ZIP de SUNAT")
    a = ap.parse_args()

    t0 = time.time()
    tmp = a.out + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("""
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-400000; PRAGMA page_size=8192;
        CREATE TABLE c(ruc INTEGER PRIMARY KEY, razon TEXT NOT NULL, estado TEXT NOT NULL, condicion TEXT, ubigeo TEXT, dir TEXT);
        CREATE TABLE ubigeo(code TEXT PRIMARY KEY, distrito TEXT, provincia TEXT, departamento TEXT) WITHOUT ROWID;
        CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
    """)
    with open(a.ubigeo, encoding="utf-8") as fh:
        rows = [(r["inei"], r["distrito"], r["provincia"], r["departamento"]) for r in csv.DictReader(fh)]
    db.executemany("INSERT OR REPLACE INTO ubigeo VALUES(?,?,?,?)", rows)

    stats = {"leidas": 0, "cargadas": 0, "omitidas": 0, "malformadas": 0, "empresas": 0}
    batch = []
    with open(a.padron, encoding="latin-1", newline="") as fh:
        header = [sin_tildes(c).strip().upper() for c in fh.readline().rstrip("\r\n").split("|")]
        if header[:len(COLS)] != COLS:
            sys.exit(f"El encabezado del padrón cambió: {header[:6]}… Revisa el formato de SUNAT antes de publicar.")
        for line in fh:
            stats["leidas"] += 1
            f = SPLIT.split(line.rstrip("\r\n"))
            if len(f) < 15 or not f[0].isdigit() or len(f[0]) != 11:
                stats["malformadas"] += 1
                continue
            est = ESTADOS.get(f[2].strip())
            if not est:
                stats["omitidas"] += 1
                continue
            ruc = f[0]
            cond = v(f[3])
            batch.append((int(ruc), v(f[1]), est, "H" if cond == "HABIDO" else cond, v(f[4]), direccion(f)))
            if ruc.startswith("20"):
                stats["empresas"] += 1
            if len(batch) >= 100_000:
                db.executemany("INSERT OR REPLACE INTO c VALUES(?,?,?,?,?,?)", batch)
                stats["cargadas"] += len(batch); batch.clear()
                if stats["cargadas"] % 2_000_000 == 0:
                    print(f"  {stats['cargadas']:,} filas · {time.time() - t0:.0f}s", flush=True)
    if batch:
        db.executemany("INSERT OR REPLACE INTO c VALUES(?,?,?,?,?,?)", batch)
        stats["cargadas"] += len(batch)

    if stats["cargadas"] < 1_000_000:
        sys.exit(f"Muy pocas filas ({stats['cargadas']:,}): el archivo de SUNAT parece incompleto. No se publica.")

    print("Indexando razones sociales de empresas (RUC 20)…", flush=True)
    db.executescript("""
        CREATE VIRTUAL TABLE c_fts USING fts5(razon, content='', tokenize='unicode61 remove_diacritics 2', detail=column);
        INSERT INTO c_fts(rowid, razon) SELECT ruc, razon FROM c WHERE ruc BETWEEN 20000000000 AND 20999999999;
        INSERT INTO c_fts(c_fts) VALUES('optimize');
    """)
    gen = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    db.executemany("INSERT INTO meta VALUES(?,?)", [
        ("generado", gen), ("fuente", "SUNAT · Padrón reducido del RUC"), ("fuente_fecha", a.fuente_fecha),
        ("registros", str(stats["cargadas"])), ("empresas", str(stats["empresas"])), ("version", "1")])
    db.commit()
    db.execute("VACUUM")
    db.close()
    os.replace(tmp, a.out)
    mb = os.path.getsize(a.out) / 1e6
    print(f"Listo: {stats['cargadas']:,} contribuyentes ({stats['empresas']:,} empresas) · {stats['omitidas']:,} de baja u otros omitidos · "
          f"{stats['malformadas']:,} malformadas · {mb:,.0f} MB · {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
