'use strict';
/**
 * Granate API — puente entre la web, SUNAT y tu base de transacciones.
 *   GET  /health                       estado, ambiente y tamaño de la base
 *   POST /cpe/emitir                   factura, boleta, NC o ND → firma, sendBill, CDR (beta o producción)
 *   POST /gre/emitir                   guía de remisión remitente → API REST de SUNAT (solo producción)
 *   POST /baja/emitir                  comunicación de baja (RA) de facturas y notas → sendSummary + getStatus
 *   GET  /baja/ticket/:ticket          vuelve a consultar una baja que quedó en proceso
 *   GET  /gre/ticket/:ruc-09-serie-num vuelve a consultar una guía que quedó en proceso
 *   GET  /padron/ruc/:ruc · /padron/buscar?q= · /padron/estado
 *   POST /bitacora                     registra un movimiento de la app
 *   GET  /bitacora?desde=&hasta=&evento=&limite=
 *   POST /archivo                      guarda la copia PDF de un documento
 *   GET  /archivo/:id/pdf              descarga una copia PDF
 *   GET  /documentos/:clave            ficha: estado, intentos de envío y copias PDF
 *   GET  /documentos/:clave/xml|cdr    XML firmado y constancia de SUNAT
 *   GET  /correlativos                 saltos y pendientes por serie
 *
 * Variables de entorno (ver .env.example):
 *   PORT, SUNAT_AMBIENTE=beta|produccion, SUNAT_RUC, SUNAT_USUARIO_SOL, SUNAT_CLAVE_SOL,
 *   CERT_PFX_PATH + CERT_PFX_PASSWORD (o CERT_KEY_PATH + CERT_PEM_PATH),
 *   SUNAT_GRE_CLIENT_ID, SUNAT_GRE_CLIENT_SECRET (credenciales de API SUNAT para guías),
 *   GRANATE_API_KEY (si existe, se exige en el encabezado X-Granate-Key), ALLOW_ORIGIN,
 *   GRANATE_DB, PADRON_REPO / PADRON_GITHUB_TOKEN / PADRON_DB
 */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { emitir, emitirGRE, emitirBaja, consultarTicket } = require('./sunat');
const padron = require('./padron');
const base = require('./db');

const env = process.env;
const AMBIENTE = env.SUNAT_AMBIENTE === 'produccion' ? 'produccion' : 'beta';
const ORIGIN = env.ALLOW_ORIGIN || '*';
const API_KEY = env.GRANATE_API_KEY || '';

function cargarCertificado() {
  if (env.CERT_PFX_PATH) {
    const forge = require('node-forge');
    const der = fs.readFileSync(env.CERT_PFX_PATH).toString('binary');
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), env.CERT_PFX_PASSWORD || '');
    const key = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key
      || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key;
    const cert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0].cert;
    return { keyPem: forge.pki.privateKeyToPem(key), certPem: forge.pki.certificateToPem(cert) };
  }
  if (env.CERT_KEY_PATH && env.CERT_PEM_PATH) return { keyPem: fs.readFileSync(env.CERT_KEY_PATH, 'utf8'), certPem: fs.readFileSync(env.CERT_PEM_PATH, 'utf8') };
  // Beta: SUNAT no exige certificado registrado. Generamos uno autofirmado en memoria.
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  const attrs = [{ name: 'commonName', value: 'Granate BETA (autofirmado)' }, { name: 'countryName', value: 'PE' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  console.log('Usando certificado autofirmado de prueba (solo beta).');
  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(cert) };
}
const CERT = cargarCertificado();
if (AMBIENTE === 'produccion' && (!env.SUNAT_USUARIO_SOL || !env.SUNAT_CLAVE_SOL || !env.CERT_PFX_PATH && !env.CERT_KEY_PATH)) {
  console.error('Producción requiere SUNAT_USUARIO_SOL, SUNAT_CLAVE_SOL y tu certificado digital.'); process.exit(1);
}
let baseLista = true;
try { base.abrir(); } catch (e) { baseLista = false; console.error('Base de transacciones no disponible:', e.message); }

const HDRS = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Granate-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' };
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...HDRS }); res.end(JSON.stringify(obj)); };
const sendFile = (res, type, nombre, buf) => { res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${nombre}"`, ...HDRS }); res.end(buf); };
const leerJSON = (req, max = 5e6) => new Promise((ok, ko) => { let b = ''; req.on('data', c => { b += c; if (b.length > max) { req.destroy(); ko(Object.assign(new Error('Cuerpo demasiado grande.'), { status: 413 })); } }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ko(e); } }); });
const valido = (d, tipos) => d && tipos.test(d.tipo) && /^[A-Z0-9]{4}$/.test(d.serie) && Number.isInteger(Number(d.numero)) && Number(d.numero) > 0;
const claveOk = k => /^\d{11}-(01|03|07|08|09|NV|COT)-[A-Z0-9]{4}-\d{1,8}$/.test(k);
const autorizado = req => { if (!API_KEY) return true; const k = String(req.headers['x-granate-key'] || ''); return k.length === API_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(API_KEY)); };
const bitacora = (ruc, d, evento, detalle) => { if (!baseLista) return; try { base.evento({ ruc, evento, docId: d.id, tipo: d.tipo, docNum: `${d.serie}-${d.numero}`, cliente: d.cliente?.nombre, monto: d.totales?.total, moneda: d.moneda, detalle, estado: '' }, 'api'); } catch (e) { console.error('bitácora', e.message); } };

async function emitirComprobante(body) {
  const d = body.documento, ruc = String(env.SUNAT_RUC || body.emisor?.ruc || '');
  if (!valido(d, /^(01|03|07|08)$/) || !/^\d{11}$/.test(ruc) || typeof body.xml !== 'string') return [400, { mensaje: 'Faltan tipo, serie, número, RUC del emisor o el XML.' }];
  if (body.ambiente === 'produccion' && AMBIENTE !== 'produccion') return [409, { mensaje: 'Esta API está en ambiente beta. Configúrala para producción antes de emitir comprobantes reales.' }];
  if (!body.xml.includes(`<cbc:ID>${d.serie}-${Number(d.numero)}</cbc:ID>`)) return [400, { mensaje: 'El número del XML no coincide con el documento.' }];
  const k = base.clave(ruc, d.tipo, d.serie, d.numero);
  if (baseLista) base.guardarDocumento(ruc, d, 'pendiente');
  const t = Date.now();
  const r = await emitir({ xml: body.xml, ruc, tipo: d.tipo, serie: d.serie, numero: Number(d.numero), ambiente: AMBIENTE, usuarioSol: env.SUNAT_USUARIO_SOL, claveSol: env.SUNAT_CLAVE_SOL, ...CERT });
  if (baseLista) { base.registrarEnvio(k, { canal: 'billService', ambiente: AMBIENTE, ...r, ms: Date.now() - t }); bitacora(ruc, d, `sunat.${String(r.estado).toLowerCase()}`, `[${r.codigo}] ${r.descripcion}`); }
  const { xmlFirmado, ...out } = r;
  console.log(new Date().toISOString(), k, r.estado, r.codigo);
  return [200, { ...out, ambiente: AMBIENTE, clave: k, xmlFirmadoBase64: Buffer.from(xmlFirmado || '').toString('base64') }];
}
async function emitirGuia(body) {
  const d = body.documento, ruc = String(env.SUNAT_RUC || body.emisor?.ruc || '');
  if (!valido(d, /^09$/) || !/^\d{11}$/.test(ruc) || typeof body.xml !== 'string') return [400, { mensaje: 'Faltan serie, número, RUC del emisor o el XML de la guía.' }];
  if (AMBIENTE !== 'produccion') return [409, { mensaje: 'SUNAT no ofrece ambiente beta para guías de remisión: configura esta API en producción (SUNAT_AMBIENTE=produccion) o usa el simulador.' }];
  if (!body.xml.includes(`<cbc:ID>${d.serie}-${Number(d.numero)}</cbc:ID>`)) return [400, { mensaje: 'El número del XML no coincide con la guía.' }];
  const k = base.clave(ruc, '09', d.serie, d.numero);
  const previo = baseLista ? base.ultimoEnvio(k) : null;
  if (previo && ['ACEPTADO', 'OBSERVADO'].includes(previo.estado)) return [200, { estado: previo.estado, codigo: previo.codigo, descripcion: previo.descripcion, hash: previo.hash, ticket: previo.ticket, ambiente: AMBIENTE, clave: k, repetido: true }];
  if (baseLista) base.guardarDocumento(ruc, d, 'pendiente');
  const t = Date.now();
  // si un envío anterior quedó en proceso, se consulta su ticket en vez de reenviar
  const r = await emitirGRE({ xml: body.xml, ruc, serie: d.serie, numero: Number(d.numero), ...CERT, clientId: env.SUNAT_GRE_CLIENT_ID, clientSecret: env.SUNAT_GRE_CLIENT_SECRET, usuarioSol: env.SUNAT_USUARIO_SOL, claveSol: env.SUNAT_CLAVE_SOL, ticketPrevio: previo && previo.estado === 'EN_PROCESO' ? previo.ticket : null });
  if (baseLista) { base.registrarEnvio(k, { canal: 'gre', ambiente: AMBIENTE, ...r, ms: Date.now() - t }); bitacora(ruc, d, r.estado === 'EN_PROCESO' ? 'sunat.error' : `sunat.${String(r.estado).toLowerCase()}`, `[${r.codigo}] ${r.descripcion}${r.ticket ? ` · ticket ${r.ticket}` : ''}`); }
  const { xmlFirmado, ...out } = r;
  console.log(new Date().toISOString(), k, r.estado, r.codigo, r.ticket || '');
  return [200, { ...out, ambiente: AMBIENTE, clave: k }];
}

async function emitirBajaCPE(body) {
  const b = body.baja || {}, ruc = String(env.SUNAT_RUC || body.emisor?.ruc || '');
  const lineas = Array.isArray(b.lineas) ? b.lineas : [];
  if (!/^RA-\d{8}-\d{1,5}$/.test(String(b.id || '')) || !/^\d{11}$/.test(ruc) || !lineas.length || typeof body.xml !== 'string') return [400, { mensaje: 'Faltan el identificador RA-AAAAMMDD-n, el RUC, los comprobantes o el XML de la baja.' }];
  if (!lineas.every(l => valido(l, /^(01|07|08)$/) && /^F/.test(l.serie))) return [400, { mensaje: 'La comunicación de baja es para facturas y sus notas (series F). Las boletas se anulan con resumen diario o nota de crédito.' }];
  if (body.ambiente === 'produccion' && AMBIENTE !== 'produccion') return [409, { mensaje: 'Esta API está en ambiente beta. Configúrala para producción antes de dar de baja comprobantes reales.' }];
  if (!body.xml.includes(`<cbc:ID>${b.id}</cbc:ID>`)) return [400, { mensaje: 'El identificador del XML no coincide con la baja.' }];
  const t = Date.now();
  const r = await emitirBaja({ xml: body.xml, ruc, id: b.id, ambiente: AMBIENTE, usuarioSol: env.SUNAT_USUARIO_SOL, claveSol: env.SUNAT_CLAVE_SOL, ...CERT });
  if (baseLista) for (const l of lineas) { const k = base.clave(ruc, l.tipo, l.serie, l.numero); try { base.registrarEnvio(k, { canal: 'baja', ambiente: AMBIENTE, ...r, ms: Date.now() - t }); } catch { /* el comprobante puede no estar en esta base */ } bitacora(ruc, { id: l.id, tipo: l.tipo, serie: l.serie, numero: l.numero }, `sunat.baja_${String(r.estado).toLowerCase()}`, `${b.id} · [${r.codigo}] ${r.descripcion}${r.ticket ? ` · ticket ${r.ticket}` : ''}`); }
  const { xmlFirmado, ...out } = r;
  console.log(new Date().toISOString(), b.id, r.estado, r.codigo, r.ticket || '');
  return [200, { ...out, ambiente: AMBIENTE, id: b.id, xmlFirmadoBase64: Buffer.from(xmlFirmado || '').toString('base64') }];
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname, q = url.searchParams;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, ambiente: AMBIENTE, servicio: 'Granate API', padron: padron.estado().disponible, base: baseLista ? base.resumen() : null, gre: !!(env.SUNAT_GRE_CLIENT_ID && env.SUNAT_GRE_CLIENT_SECRET), protegida: !!API_KEY });
    if (!autorizado(req)) return send(res, 401, { mensaje: 'Falta la clave de tu API (encabezado X-Granate-Key).' });
    if (req.method === 'GET' && p.startsWith('/padron/ruc/')) { const r = padron.consultarRuc(decodeURIComponent(p.slice(12))); return r.dato ? send(res, 200, r.dato) : send(res, r.error, { mensaje: r.mensaje, ruc: r.ruc }); }
    if (req.method === 'GET' && p === '/padron/buscar') { const r = padron.buscar(q.get('q'), q.get('limite')); return r.error ? send(res, r.error, { mensaje: r.mensaje }) : send(res, 200, r); }
    if (req.method === 'GET' && p === '/padron/estado') return send(res, 200, padron.estado());
    if (req.method === 'POST' && (p === '/cpe/emitir' || p === '/gre/emitir')) {
      let body; try { body = await leerJSON(req); } catch { return send(res, 400, { mensaje: 'JSON inválido.' }); }
      try { const [st, out] = p === '/cpe/emitir' ? await emitirComprobante(body) : await emitirGuia(body); return send(res, st, out); }
      catch (e) { console.error(e); return send(res, e.status || 502, { mensaje: e.name === 'AbortError' ? 'SUNAT no respondió a tiempo. Reintenta con el mismo número.' : e.status ? e.message : `No se pudo comunicar con SUNAT: ${e.message}` }); }
    }
    if (req.method === 'POST' && p === '/baja/emitir') {
      let body; try { body = await leerJSON(req); } catch { return send(res, 400, { mensaje: 'JSON inválido.' }); }
      try { const [st, out] = await emitirBajaCPE(body); return send(res, st, out); }
      catch (e) { console.error(e); return send(res, 502, { mensaje: e.name === 'AbortError' ? 'SUNAT no respondió a tiempo. Consulta la baja en unos minutos.' : `No se pudo comunicar con SUNAT: ${e.message}` }); }
    }
    if (req.method === 'GET' && p.startsWith('/baja/ticket/')) {
      const ticket = decodeURIComponent(p.slice(13)), ruc = String(env.SUNAT_RUC || q.get('ruc') || '');
      if (!/^[\w-]{6,40}$/.test(ticket) || !/^\d{11}$/.test(ruc)) return send(res, 400, { mensaje: 'Ticket o RUC inválido.' });
      try { return send(res, 200, await consultarTicket({ ticket, ruc, ambiente: AMBIENTE, usuarioSol: env.SUNAT_USUARIO_SOL, claveSol: env.SUNAT_CLAVE_SOL })); }
      catch (e) { return send(res, 502, { mensaje: `No se pudo consultar a SUNAT: ${e.message}` }); }
    }
    if (!baseLista && /^\/(bitacora|archivo|documentos|correlativos|gre\/ticket)/.test(p)) return send(res, 503, { mensaje: 'La base de transacciones no está disponible (requiere Node 22.13+).' });
    if (req.method === 'GET' && p.startsWith('/gre/ticket/')) {
      const k = decodeURIComponent(p.slice(12)); if (!claveOk(k)) return send(res, 400, { mensaje: 'Clave inválida.' });
      const doc = base.ficha(k); if (!doc) return send(res, 404, { mensaje: 'Guía no registrada en esta API.' });
      const ultimo = doc.envios.at(-1);
      if (!ultimo || ultimo.estado !== 'EN_PROCESO') return send(res, 200, { estado: ultimo?.estado || 'SIN_ENVIO', codigo: ultimo?.codigo, descripcion: ultimo?.descripcion, ticket: ultimo?.ticket });
      const r = await emitirGRE({ xml: '', ruc: doc.ruc, serie: doc.serie, numero: doc.numero, ...CERT, clientId: env.SUNAT_GRE_CLIENT_ID, clientSecret: env.SUNAT_GRE_CLIENT_SECRET, usuarioSol: env.SUNAT_USUARIO_SOL, claveSol: env.SUNAT_CLAVE_SOL, ticketPrevio: ultimo.ticket, intentos: 2 });
      base.registrarEnvio(k, { canal: 'gre', ambiente: AMBIENTE, ...r });
      const { xmlFirmado, ...out } = r; return send(res, 200, out);
    }
    if (req.method === 'POST' && p === '/bitacora') {
      const b = await leerJSON(req, 2e5);
      if (!b.evento) return send(res, 400, { mensaje: 'Falta el tipo de evento.' });
      return send(res, 200, { id: base.evento({ ...b, ruc: env.SUNAT_RUC || b.ruc }) });
    }
    if (req.method === 'GET' && p === '/bitacora') return send(res, 200, { datos: base.eventos({ ruc: env.SUNAT_RUC || q.get('ruc'), desde: q.get('desde'), hasta: q.get('hasta'), evento: q.get('evento'), limite: q.get('limite') }) });
    if (req.method === 'POST' && p === '/archivo') {
      const b = await leerJSON(req, 12e6);
      const ruc = String(env.SUNAT_RUC || b.ruc || '');
      if (b.documento && b.documento.numero) base.guardarDocumento(ruc, b.documento);
      const id = base.guardarArchivo({ ruc, docId: b.docId, tipo: b.tipo, serie: b.serie, numero: b.numero, version: b.version, nombre: b.nombre, nota: b.nota, pdf: b.pdfBase64 });
      return send(res, 200, { id });
    }
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/archivo\/([0-9a-f-]{36})\/pdf$/))) { const a = base.leerArchivo(m[1]); return a ? sendFile(res, 'application/pdf', a.nombre, Buffer.from(a.pdf)) : send(res, 404, { mensaje: 'Copia no encontrada.' }); }
    if (req.method === 'GET' && (m = p.match(/^\/documentos\/([^/]+)(?:\/(xml|cdr))?$/))) {
      const k = decodeURIComponent(m[1]); if (!claveOk(k)) return send(res, 400, { mensaje: 'Clave inválida: usa ruc-tipo-serie-numero.' });
      if (!m[2]) { const f = base.ficha(k); return f ? send(res, 200, f) : send(res, 404, { mensaje: 'Documento no registrado.' }); }
      const a = base.archivosSunat(k); if (!a) return send(res, 404, { mensaje: 'Sin archivos de SUNAT para este documento.' });
      return m[2] === 'xml' ? (a.xml_firmado ? sendFile(res, 'application/xml', `${k}.xml`, Buffer.from(a.xml_firmado)) : send(res, 404, { mensaje: 'Sin XML firmado.' })) : (a.cdr_zip ? sendFile(res, 'application/zip', `R-${k}.zip`, Buffer.from(a.cdr_zip)) : send(res, 404, { mensaje: 'Sin CDR.' }));
    }
    if (req.method === 'GET' && p === '/correlativos') return send(res, 200, { datos: base.correlativos(env.SUNAT_RUC || q.get('ruc')) });
    send(res, 404, { mensaje: 'Ruta no encontrada.' });
  } catch (e) { if (!e.status) console.error(e); send(res, e.status || 500, { mensaje: e.status ? e.message : 'Error interno de la API.' }); }
}).listen(Number(env.PORT) || 7071, () => { console.log(`Granate API · ambiente ${AMBIENTE} · puerto ${Number(env.PORT) || 7071}${API_KEY ? ' · protegida con X-Granate-Key' : ''} · base ${baseLista ? base.DB_PATH : 'no disponible'}`); padron.iniciar(); });
