'use strict';
/**
 * Granate API — puente entre la web y SUNAT.
 *   GET  /health            → estado y ambiente
 *   POST /cpe/emitir        → firma, envía a SUNAT y devuelve el CDR
 *   GET  /padron/ruc/:ruc   → datos del padrón SUNAT por RUC (o DNI → RUC 10)
 *   GET  /padron/buscar?q=  → empresas por razón social
 *   GET  /padron/estado     → fecha y tamaño del padrón cargado
 *
 * Variables de entorno:
 *   PORT=7071
 *   SUNAT_AMBIENTE=beta | produccion          (beta por defecto)
 *   SUNAT_RUC=20xxxxxxxxx                     (opcional: fuerza el RUC emisor)
 *   SUNAT_USUARIO_SOL=USUARIO  SUNAT_CLAVE_SOL=****   (solo producción)
 *   CERT_PFX_PATH=./certificado.pfx  CERT_PFX_PASSWORD=****   (certificado digital)
 *     o bien CERT_KEY_PATH=./key.pem  CERT_PEM_PATH=./cert.pem
 *   ALLOW_ORIGIN=https://tu-dominio.pe        (CORS; * por defecto)
 *   PADRON_REPO / PADRON_GITHUB_TOKEN / PADRON_DB   (ver padron.js)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { emitir } = require('./sunat');
const padron = require('./padron');

const env = process.env;
const AMBIENTE = env.SUNAT_AMBIENTE === 'produccion' ? 'produccion' : 'beta';
const ORIGIN = env.ALLOW_ORIGIN || '*';

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

const send = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' });
  res.end(JSON.stringify(obj));
};
const leerJSON = req => new Promise((ok, ko) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ko(e); } }); });
const valido = (d) => d && /^(01|03|07|08)$/.test(d.tipo) && /^[A-Z0-9]{4}$/.test(d.serie) && Number.isInteger(Number(d.numero)) && Number(d.numero) > 0;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, ambiente: AMBIENTE, servicio: 'Granate API', padron: padron.estado().disponible });
  if (req.method === 'GET' && url.pathname.startsWith('/padron/ruc/')) { const r = padron.consultarRuc(decodeURIComponent(url.pathname.slice(12))); return r.dato ? send(res, 200, r.dato) : send(res, r.error, { mensaje: r.mensaje, ruc: r.ruc }); }
  if (req.method === 'GET' && url.pathname === '/padron/buscar') { const r = padron.buscar(url.searchParams.get('q'), url.searchParams.get('limite')); return r.error ? send(res, r.error, { mensaje: r.mensaje }) : send(res, 200, r); }
  if (req.method === 'GET' && url.pathname === '/padron/estado') return send(res, 200, padron.estado());
  if (req.method === 'POST' && url.pathname === '/cpe/emitir') {
    let body; try { body = await leerJSON(req); } catch { return send(res, 400, { mensaje: 'JSON inválido.' }); }
    const d = body.documento, ruc = env.SUNAT_RUC || body.emisor?.ruc;
    if (!valido(d) || !/^\d{11}$/.test(String(ruc)) || typeof body.xml !== 'string') return send(res, 400, { mensaje: 'Faltan tipo, serie, número, RUC del emisor o el XML.' });
    if (body.ambiente === 'produccion' && AMBIENTE !== 'produccion') return send(res, 409, { mensaje: 'Esta API está en ambiente beta. Configúrala para producción antes de emitir comprobantes reales.' });
    if (!body.xml.includes(`<cbc:ID>${d.serie}-${Number(d.numero)}</cbc:ID>`)) return send(res, 400, { mensaje: 'El número del XML no coincide con el documento.' });
    try {
      const r = await emitir({ xml: body.xml, ruc: String(ruc), tipo: d.tipo, serie: d.serie, numero: Number(d.numero), ambiente: AMBIENTE, usuarioSol: env.SUNAT_USUARIO_SOL, claveSol: env.SUNAT_CLAVE_SOL, ...CERT });
      const { xmlFirmado, ...out } = r;
      console.log(new Date().toISOString(), `${ruc}-${d.tipo}-${d.serie}-${d.numero}`, r.estado, r.codigo);
      return send(res, 200, { ...out, ambiente: AMBIENTE, xmlFirmadoBase64: Buffer.from(xmlFirmado || '').toString('base64') });
    } catch (e) {
      console.error(e);
      return send(res, 502, { mensaje: e.name === 'AbortError' ? 'SUNAT no respondió a tiempo. Reintenta con el mismo número.' : `No se pudo comunicar con SUNAT: ${e.message}` });
    }
  }
  send(res, 404, { mensaje: 'Ruta no encontrada.' });
}).listen(Number(env.PORT) || 7071, () => { console.log(`Granate API · ambiente ${AMBIENTE} · puerto ${Number(env.PORT) || 7071}`); padron.iniciar(); });
