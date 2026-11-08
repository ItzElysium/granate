'use strict';
/**
 * Base de transacciones de Granate (SQLite, incluida en Node ≥ 22.13).
 * Guarda todo lo que pasa con tus documentos para auditoría y para SUNAT:
 *   documentos  último estado de cada comprobante, guía o nota (JSON completo)
 *   envios      cada intento de envío: XML firmado, CDR, código y ticket (nunca se borra)
 *   eventos     bitácora de la app: quién hizo qué y cuándo
 *   archivos    copias PDF (con versión) de lo emitido
 * Los correlativos se controlan desde documentos: saltos y duplicados por serie.
 *
 *   GRANATE_DB=./data/granate.db
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let DatabaseSync; try { ({ DatabaseSync } = require('node:sqlite')); } catch { DatabaseSync = null; }

const DB_PATH = path.resolve(process.env.GRANATE_DB || path.join(__dirname, 'data', 'granate.db'));
let db = null, S = null;

function abrir() {
  if (db) return db;
  if (!DatabaseSync) throw new Error('Tu versión de Node no trae SQLite: usa Node 22.13 o superior.');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS documentos (
      clave TEXT PRIMARY KEY,               -- ruc-tipo-serie-numero (lo que SUNAT reconoce)
      id_app TEXT, ruc TEXT NOT NULL, tipo TEXT NOT NULL, serie TEXT NOT NULL, numero INTEGER NOT NULL,
      fecha TEXT, cliente_doc TEXT, cliente_nombre TEXT, moneda TEXT, total REAL, detraccion REAL,
      operacion TEXT, estado TEXT, json TEXT, creado TEXT NOT NULL, actualizado TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_doc_serie ON documentos (ruc, tipo, serie, numero);
    CREATE INDEX IF NOT EXISTS ix_doc_fecha ON documentos (ruc, fecha);
    CREATE TABLE IF NOT EXISTS envios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, clave TEXT NOT NULL, canal TEXT NOT NULL, ambiente TEXT,
      estado TEXT, codigo TEXT, descripcion TEXT, observaciones TEXT, hash TEXT, ticket TEXT,
      xml_firmado TEXT, cdr_zip BLOB, ms INTEGER, ts TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_env_clave ON envios (clave, id);
    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, ruc TEXT, evento TEXT NOT NULL, doc_id TEXT, tipo TEXT, doc_num TEXT,
      cliente TEXT, monto REAL, moneda TEXT, detalle TEXT, estado TEXT, usuario TEXT, origen TEXT);
    CREATE INDEX IF NOT EXISTS ix_ev_ts ON eventos (ruc, ts);
    CREATE TABLE IF NOT EXISTS archivos (
      id TEXT PRIMARY KEY, ruc TEXT, doc_id TEXT, clave TEXT, tipo TEXT, serie TEXT, numero INTEGER, version INTEGER,
      nombre TEXT, nota TEXT, pdf BLOB NOT NULL, sha256 TEXT, bytes INTEGER, ts TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_arc_doc ON archivos (doc_id, ts);
  `);
  S = {
    doc: db.prepare(`INSERT INTO documentos (clave, id_app, ruc, tipo, serie, numero, fecha, cliente_doc, cliente_nombre, moneda, total, detraccion, operacion, estado, json, creado, actualizado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET id_app = excluded.id_app, fecha = excluded.fecha, cliente_doc = excluded.cliente_doc, cliente_nombre = excluded.cliente_nombre,
        moneda = excluded.moneda, total = excluded.total, detraccion = excluded.detraccion, operacion = excluded.operacion,
        estado = COALESCE(excluded.estado, documentos.estado), json = excluded.json, actualizado = excluded.actualizado`),
    estadoDoc: db.prepare('UPDATE documentos SET estado = ?, actualizado = ? WHERE clave = ?'),
    envio: db.prepare('INSERT INTO envios (clave, canal, ambiente, estado, codigo, descripcion, observaciones, hash, ticket, xml_firmado, cdr_zip, ms, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    ultimoEnvio: db.prepare('SELECT * FROM envios WHERE clave = ? ORDER BY id DESC LIMIT 1'),
    envios: db.prepare('SELECT id, canal, ambiente, estado, codigo, descripcion, observaciones, hash, ticket, ms, ts, length(xml_firmado) AS xml_bytes, length(cdr_zip) AS cdr_bytes FROM envios WHERE clave = ? ORDER BY id'),
    // XML y CDR del propio comprobante (billService o gre): una baja posterior no debe ocultarlos
    envioArchivo: db.prepare("SELECT xml_firmado, cdr_zip FROM envios WHERE clave = ? AND canal IN ('billService', 'gre') AND (xml_firmado IS NOT NULL OR cdr_zip IS NOT NULL) ORDER BY id DESC LIMIT 1"),
    clavesTicket: db.prepare("SELECT DISTINCT clave FROM envios WHERE ticket = ? AND canal = 'baja'"),
    getDoc: db.prepare('SELECT clave, id_app, ruc, tipo, serie, numero, fecha, cliente_doc, cliente_nombre, moneda, total, detraccion, operacion, estado, creado, actualizado FROM documentos WHERE clave = ?'),
    evento: db.prepare(`INSERT INTO eventos (id, ts, ruc, evento, doc_id, tipo, doc_num, cliente, monto, moneda, detalle, estado, usuario, origen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, detalle = excluded.detalle, estado = excluded.estado`),
    archivo: db.prepare('INSERT INTO archivos (id, ruc, doc_id, clave, tipo, serie, numero, version, nombre, nota, pdf, sha256, bytes, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    getArchivo: db.prepare('SELECT nombre, pdf FROM archivos WHERE id = ?'),
    archivosDoc: db.prepare('SELECT id, version, nombre, nota, bytes, sha256, ts FROM archivos WHERE doc_id = ? OR clave = ? ORDER BY ts DESC'),
  };
  return db;
}
const ahora = () => new Date().toISOString();
const clave = (ruc, tipo, serie, numero) => `${ruc}-${tipo}-${serie}-${Number(numero)}`;

/** Guarda (o actualiza) un documento con su JSON completo. */
function guardarDocumento(ruc, d, estado) {
  abrir();
  if (!d || !d.tipo || !d.serie || !d.numero) return null;
  const k = clave(ruc, d.tipo, d.serie, d.numero), t = ahora(), tot = d.totales || {};
  S.doc.run(k, d.id || null, String(ruc), d.tipo, d.serie, Number(d.numero), d.fecha || null, d.cliente?.numDoc || null, d.cliente?.nombre || null,
    d.moneda || null, Number(tot.total) || null, Number(tot.detraccion) || null, d.operacion || null, estado || d.estado || null, JSON.stringify(d), t, t);
  return k;
}
/** Registra un intento de envío a SUNAT (inmutable). */
function registrarEnvio(k, { canal, ambiente, estado, codigo, descripcion, observaciones, hash, ticket, xmlFirmado, cdrZipBase64, ms }) {
  abrir();
  S.envio.run(k, canal, ambiente || null, estado || null, codigo != null ? String(codigo) : null, descripcion || null, JSON.stringify(observaciones || []), hash || null, ticket || null,
    xmlFirmado || null, cdrZipBase64 ? Buffer.from(cdrZipBase64, 'base64') : null, Number(ms) || null, ahora());
  const nuevo = estadoDocumento(canal, estado);
  if (nuevo) S.estadoDoc.run(nuevo, ahora(), k);
}
/**
 * Estado del comprobante según el envío. Una baja no reemplaza el estado del comprobante
 * mientras SUNAT no la acepte: la factura sigue «aceptado» y la baja va en su propio registro.
 */
function estadoDocumento(canal, estado) {
  if (!estado) return null;
  const e = String(estado).toUpperCase();
  if (canal === 'baja') return ['ACEPTADO', 'OBSERVADO'].includes(e) ? 'anulado' : null;
  return e.toLowerCase();
}
/** Comprobantes incluidos en una comunicación de baja, por su ticket. */
const clavesDeTicket = t => (abrir(), S.clavesTicket.all(String(t)).map(f => f.clave));
const ultimoEnvio = k => (abrir(), S.ultimoEnvio.get(k));
function evento(e, origen = 'web') {
  abrir();
  const id = String(e.id || crypto.randomUUID());
  S.evento.run(id, e.ts || ahora(), e.ruc || null, String(e.evento || 'evento'), e.docId || null, e.tipo || null, e.docNum || null, e.cliente || null,
    Number(e.monto) || 0, e.moneda || null, String(e.detalle || '').slice(0, 500), e.estado || null, e.usuario || null, origen);
  return id;
}
function eventos({ ruc, desde, hasta, evento: ev, limite = 500 } = {}) {
  abrir();
  const w = [], p = [];
  if (ruc) { w.push('ruc = ?'); p.push(ruc); }
  if (desde) { w.push('ts >= ?'); p.push(desde); }
  if (hasta) { w.push('ts < ?'); p.push(hasta + 'T23:59:59.999Z'); }
  if (ev) { w.push('evento LIKE ?'); p.push(ev.replace(/\*$/, '') + '%'); }
  return db.prepare(`SELECT * FROM eventos ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${Math.min(5000, Math.max(1, Number(limite) || 500))}`).all(...p);
}
function guardarArchivo({ ruc, docId, tipo, serie, numero, version, nombre, nota, pdf }) {
  abrir();
  const buf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(String(pdf || ''), 'base64');
  if (buf.length < 100 || buf.subarray(0, 5).toString() !== '%PDF-') throw Object.assign(new Error('El archivo no es un PDF válido.'), { status: 400 });
  if (buf.length > 8e6) throw Object.assign(new Error('El PDF supera 8 MB.'), { status: 413 });
  const id = crypto.randomUUID();
  S.archivo.run(id, ruc || null, docId || null, ruc && tipo && serie && numero ? clave(ruc, tipo, serie, numero) : null, tipo || null, serie || null, Number(numero) || null, Number(version) || 1,
    String(nombre || `${id}.pdf`).replace(/[^\w.\-]/g, '_'), nota || null, buf, crypto.createHash('sha256').update(buf).digest('hex'), buf.length, ahora());
  return id;
}
const leerArchivo = id => (abrir(), S.getArchivo.get(String(id)));
/** Ficha de un documento: datos, intentos de envío y copias PDF. */
function ficha(k) {
  abrir();
  const d = S.getDoc.get(k); if (!d) return null;
  return { ...d, envios: S.envios.all(k).map(e => ({ ...e, observaciones: JSON.parse(e.observaciones || '[]') })), archivos: S.archivosDoc.all(d.id_app || '', k) };
}
const archivosSunat = k => (abrir(), S.envioArchivo.get(k));
/** Control de correlativos: emitidos, último número, saltos y pendientes por serie. */
function correlativos(ruc) {
  abrir();
  const filas = db.prepare(`SELECT tipo, serie, numero, estado FROM documentos ${ruc ? 'WHERE ruc = ?' : ''} ORDER BY tipo, serie, numero`).all(...(ruc ? [ruc] : []));
  const g = new Map();
  for (const f of filas) { const key = `${f.tipo}|${f.serie}`; if (!g.has(key)) g.set(key, []); g.get(key).push(f); }
  return [...g.entries()].map(([key, fs_]) => {
    const [tipo, serie] = key.split('|'), nums = new Set(fs_.map(f => f.numero)), max = Math.max(...nums), faltan = [];
    for (let n = 1; n <= max && faltan.length < 100; n++) if (!nums.has(n)) faltan.push(n);
    return { tipo, serie, emitidos: nums.size, ultimo: max, faltan, pendientes: fs_.filter(f => !['aceptado', 'observado', 'anulado'].includes(String(f.estado || '').toLowerCase())).map(f => f.numero) };
  });
}
function resumen() {
  abrir();
  const c = t => db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  return { ruta: DB_PATH, documentos: c('documentos'), envios: c('envios'), eventos: c('eventos'), archivos: c('archivos') };
}
module.exports = { abrir, clave, guardarDocumento, registrarEnvio, estadoDocumento, clavesDeTicket, ultimoEnvio, evento, eventos, guardarArchivo, leerArchivo, ficha, archivosSunat, correlativos, resumen, DB_PATH };
