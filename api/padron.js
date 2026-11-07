'use strict';
/**
 * Padrón RUC de SUNAT para autocompletar clientes.
 * Lee padron.db (SQLite) que publica el robot de GitHub y lo mantiene al día solo.
 *
 * Variables de entorno:
 *   PADRON_DB=./data/padron.db        ruta local de la base
 *   PADRON_REPO=dataprix-pe/granate   repositorio donde el robot publica los Releases
 *   PADRON_GITHUB_TOKEN=github_pat_…  token de solo lectura (obligatorio si el repo es privado)
 *   PADRON_ACTUALIZAR_HORAS=6         cada cuánto revisar si hay versión nueva
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { DatabaseSync = null; }

const env = process.env;
const DB_PATH = path.resolve(env.PADRON_DB || path.join(__dirname, 'data', 'padron.db'));
const REPO = env.PADRON_REPO || '';
const GH_API = (env.PADRON_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const TOKEN = env.PADRON_GITHUB_TOKEN || env.GITHUB_TOKEN || '';
const HORAS = Number(env.PADRON_ACTUALIZAR_HORAS) || 6;
const ESTADO = { A: 'ACTIVO', S: 'SUSPENSION TEMPORAL' };
const W = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

let db = null, meta = {}, stmts = null, actualizando = false, ultimoError = '';

function abrir() {
  if (!DatabaseSync) { ultimoError = 'Tu versión de Node no trae SQLite (usa Node 22.13 o superior).'; return; }
  if (!fs.existsSync(DB_PATH)) { ultimoError = 'Aún no hay padrón descargado.'; return; }
  const nuevo = new DatabaseSync(DB_PATH, { readOnly: true });
  const m = Object.fromEntries(nuevo.prepare('SELECT k, v FROM meta').all().map(r => [r.k, r.v]));
  const s = {
    ruc: nuevo.prepare('SELECT c.ruc, c.razon, c.estado, c.condicion, c.ubigeo, c.dir, u.distrito, u.provincia, u.departamento FROM c LEFT JOIN ubigeo u ON u.code = c.ubigeo WHERE c.ruc = ?'),
    buscar: nuevo.prepare(`SELECT c.ruc, c.razon, c.estado, c.condicion, c.ubigeo, c.dir, u.distrito, u.provincia, u.departamento
      FROM c_fts f JOIN c ON c.ruc = f.rowid LEFT JOIN ubigeo u ON u.code = c.ubigeo
      WHERE c_fts MATCH ? ORDER BY (c.estado = 'A') DESC, (c.razon LIKE ?) DESC, length(c.razon), bm25(c_fts) LIMIT ?`),
  };
  const viejo = db; db = nuevo; meta = m; stmts = s; ultimoError = '';
  if (viejo) try { viejo.close(); } catch { /* */ }
  console.log(`Padrón SUNAT listo: ${Number(meta.registros).toLocaleString('es-PE')} contribuyentes · ${meta.fuente_fecha || meta.generado}`);
}

const titulo = s => String(s || '');
function formato(r) {
  if (!r) return null;
  const ubic = [r.distrito, r.provincia, r.departamento].filter(Boolean).join(' - ');
  r.dir = String(r.dir || '').replace(/(^|\s)-{2,}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  const cond = r.condicion === 'H' ? 'HABIDO' : (r.condicion || '');
  return {
    ruc: String(r.ruc), razonSocial: titulo(r.razon), estado: ESTADO[r.estado] || r.estado, condicion: cond,
    direccion: r.dir || '', ubigeo: r.ubigeo || '', distrito: r.distrito || '', provincia: r.provincia || '', departamento: r.departamento || '',
    direccionCompleta: [r.dir, ubic].filter(Boolean).join(', '),
    apto: r.estado === 'A' && cond === 'HABIDO',
  };
}
function rucDeDni(dni) {
  const b = '10' + dni; let s = 0; for (let i = 0; i < 10; i++) s += Number(b[i]) * W[i];
  let d = 11 - (s % 11); if (d === 10) d = 0; if (d === 11) d = 1; return b + d;
}

function consultarRuc(valor) {
  if (!stmts) return { error: 503, mensaje: ultimoError || 'Padrón no disponible.' };
  let v = String(valor || '').replace(/\D/g, '');
  if (/^\d{8}$/.test(v)) v = rucDeDni(v);
  if (!/^\d{11}$/.test(v)) return { error: 400, mensaje: 'Ingresa un RUC de 11 dígitos o un DNI de 8.' };
  const r = formato(stmts.ruc.get(Number(v)));
  return r ? { dato: r } : { error: 404, mensaje: 'Este RUC no figura como activo en el padrón de SUNAT: puede estar de baja. Verifícalo antes de facturar.', ruc: v };
}

function buscar(q, limite = 8) {
  if (!stmts) return { error: 503, mensaje: ultimoError || 'Padrón no disponible.' };
  const toks = String(q || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().match(/[A-Z0-9Ñ]+/g) || [];
  const utiles = toks.filter(t => t.length >= 2).slice(0, 6);
  if (!utiles.length) return { datos: [] };
  const match = utiles.map(t => `"${t}"*`).join(' ');
  return { datos: stmts.buscar.all(match, `%${utiles.join(' ')}%`, Math.min(Number(limite) || 8, 20)).map(formato) };
}

function estado() {
  return { disponible: !!stmts, registros: Number(meta.registros || 0), empresas: Number(meta.empresas || 0), fuente: meta.fuente || 'SUNAT · Padrón reducido del RUC', fuenteFecha: meta.fuente_fecha || '', generado: meta.generado || '', repo: REPO, actualizando, mensaje: ultimoError };
}

async function actualizar() {
  if (!REPO || actualizando) return;
  actualizando = true;
  try {
    const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'granate-api', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
    const rel = await fetch(`${GH_API}/repos/${REPO}/releases/latest`, { headers: h });
    if (!rel.ok) throw new Error(`GitHub respondió ${rel.status} al buscar el último padrón${rel.status === 404 ? ' (¿repo privado sin token?)' : ''}.`);
    const j = await rel.json();
    const asset = (j.assets || []).find(a => a.name === 'padron.db.gz');
    if (!asset) throw new Error('El último Release no trae padron.db.gz.');
    const marca = path.join(path.dirname(DB_PATH), 'padron.tag');
    if (fs.existsSync(DB_PATH) && fs.existsSync(marca) && fs.readFileSync(marca, 'utf8').trim() === j.tag_name) return;
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    console.log(`Descargando padrón ${j.tag_name} (${(asset.size / 1e6).toFixed(0)} MB)…`);
    const r = await fetch(`${GH_API}/repos/${REPO}/releases/assets/${asset.id}`, { headers: { ...h, Accept: 'application/octet-stream' } });
    if (!r.ok || !r.body) throw new Error(`No se pudo descargar el padrón (${r.status}).`);
    const tmp = DB_PATH + '.descarga';
    await pipeline(Readable.fromWeb(r.body), zlib.createGunzip(), fs.createWriteStream(tmp));
    const prueba = new DatabaseSync(tmp, { readOnly: true });
    const n = prueba.prepare("SELECT v FROM meta WHERE k = 'registros'").get(); prueba.close();
    if (!n || Number(n.v) < 1e6) throw new Error('El padrón descargado está incompleto; se mantiene el anterior.');
    if (db) { try { db.close(); } catch { /* */ } db = null; stmts = null; }
    fs.renameSync(tmp, DB_PATH);
    fs.writeFileSync(marca, j.tag_name);
    abrir();
  } catch (e) {
    ultimoError = e.message; console.error('Padrón:', e.message);
    if (!stmts && fs.existsSync(DB_PATH)) try { abrir(); } catch { /* */ }
  } finally { actualizando = false; }
}

function iniciar() {
  try { abrir(); } catch (e) { ultimoError = `No se pudo abrir el padrón: ${e.message}`; }
  actualizar();
  setInterval(actualizar, HORAS * 3600e3).unref();
}

module.exports = { iniciar, consultarRuc, buscar, estado, actualizar, rucDeDni };
