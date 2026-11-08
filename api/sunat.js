'use strict';
/**
 * Conector SUNAT (SEE del contribuyente) — Granate
 * Firma el XML UBL 2.1 (XMLDSig), lo comprime en ZIP, lo envía con sendBill
 * y lee la Constancia de Recepción (CDR).
 *
 * Beta oficial: no exige certificado registrado; usuario [RUC]MODDATOS / clave MODDATOS.
 */
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const JSZip = require('jszip');

const ENDPOINTS = {
  beta: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
  produccion: 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService',
};
const ALG = {
  rsaSha1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  sha1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  c14n: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
};

/** Firma enveloped dentro de ext:ExtensionContent, con Id="SignatureSP" (lo que referencia cac:Signature). */
function firmarXML(xml, { keyPem, certPem }) {
  const limpio = xml.replace(/<ext:ExtensionContent>[\s\S]*?<\/ext:ExtensionContent>/, '<ext:ExtensionContent></ext:ExtensionContent>');
  const sig = new SignedXml({ privateKey: keyPem, publicCert: certPem, signatureAlgorithm: ALG.rsaSha1, canonicalizationAlgorithm: ALG.c14n });
  sig.addReference({ xpath: '/*', transforms: [ALG.enveloped], digestAlgorithm: ALG.sha1, isEmptyUri: true });
  sig.computeSignature(limpio, { prefix: 'ds', attrs: { Id: 'SignatureSP' }, location: { reference: "//*[local-name(.)='ExtensionContent']", action: 'append' } });
  const firmado = sig.getSignedXml();
  const hash = (firmado.match(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/) || [])[1] || '';
  return { xml: firmado, hash };
}

async function zipBase64(nombre, contenido) {
  const z = new JSZip(); z.file(nombre, contenido);
  return z.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

const esperar = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
function sobreSOAP(usuario, clave, nombreZip, b64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${esc(usuario)}</wsse:Username><wsse:Password>${esc(clave)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>
  <soapenv:Body><ser:sendBill><fileName>${esc(nombreZip)}</fileName><contentFile>${b64}</contentFile></ser:sendBill></soapenv:Body>
</soapenv:Envelope>`;
}

const texto = (doc, local) => { const n = doc.getElementsByTagNameNS('*', local); return n.length ? n[0].textContent.trim() : ''; };

/** Lee el CDR (R-*.xml dentro del ZIP de applicationResponse). */
async function leerCDR(b64) {
  const z = await JSZip.loadAsync(b64, { base64: true });
  const f = Object.keys(z.files).find(n => /\.xml$/i.test(n));
  const xml = await z.file(f).async('string');
  const d = new DOMParser().parseFromString(xml, 'text/xml');
  const codigo = texto(d, 'ResponseCode');
  const descripcion = texto(d, 'Description');
  const notas = [...d.getElementsByTagNameNS('*', 'Note')].map(n => n.textContent.trim()).filter(Boolean);
  return { codigo, descripcion, observaciones: notas, cdrXml: xml, cdrNombre: f };
}

/**
 * Envía un comprobante a SUNAT.
 * @returns {estado:'ACEPTADO'|'OBSERVADO'|'RECHAZADO', codigo, descripcion, observaciones, hash, cdrZipBase64}
 */
async function emitir({ xml, ruc, tipo, serie, numero, ambiente = 'beta', usuarioSol, claveSol, keyPem, certPem, endpoint, timeoutMs = 45000 }) {
  const base = `${ruc}-${tipo}-${serie}-${numero}`;
  const { xml: firmado, hash } = firmarXML(xml, { keyPem, certPem });
  const b64 = await zipBase64(`${base}.xml`, firmado);
  const user = ambiente === 'beta' ? `${ruc}MODDATOS` : `${ruc}${usuarioSol}`;
  const pass = ambiente === 'beta' ? 'MODDATOS' : claveSol;
  const url = endpoint || ENDPOINTS[ambiente];
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs);
  let res, body;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:sendBill' }, body: sobreSOAP(user, pass, `${base}.zip`, b64), signal: ctl.signal });
    body = await res.text();
  } finally { clearTimeout(to); }
  const d = new DOMParser().parseFromString(body, 'text/xml');
  const ar = texto(d, 'applicationResponse');
  if (ar) {
    const cdr = await leerCDR(ar);
    const n = Number(cdr.codigo);
    const estado = n === 0 ? (cdr.observaciones.length ? 'OBSERVADO' : 'ACEPTADO') : n >= 4000 ? 'OBSERVADO' : 'RECHAZADO';
    return { estado, codigo: cdr.codigo, descripcion: cdr.descripcion, observaciones: cdr.observaciones, hash, cdrZipBase64: ar, xmlFirmado: firmado };
  }
  // SOAP Fault: código de error de SUNAT en faultstring (p. ej. "2800") y detalle en <message>
  const faultcode = texto(d, 'faultcode');
  const faultstring = texto(d, 'faultstring');
  const detalle = texto(d, 'message') || texto(d, 'detail');
  const codigo = (faultcode.match(/(\d{4})/) || detalle.match(/INFO\s*:\s*(\d{4})/) || faultstring.match(/^(\d{4})$/) || [])[1] || faultcode || `HTTP ${res.status}`;
  const descripcion = (/^\d+$/.test(faultstring) ? detalle : faultstring.replace(/\s*-\s*Detalle:[\s\S]*$/, '')) || detalle || `HTTP ${res.status}`;
  // Códigos 0100–1999: excepción de forma (se puede corregir y reenviar con el mismo número); 2000–3999: rechazo.
  const n = Number(codigo);
  return { estado: n >= 100 && n < 2000 ? 'ERROR' : 'RECHAZADO', codigo, descripcion, detalle: faultstring, observaciones: [], hash, xmlFirmado: firmado, http: res.status };
}

/* =====================================================================
   Comunicación de baja (RA) · sendSummary → ticket → getStatus
   ===================================================================== */
function sobreOp(usuario, clave, cuerpo) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <soapenv:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${esc(usuario)}</wsse:Username><wsse:Password>${esc(clave)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>
  <soapenv:Body>${cuerpo}</soapenv:Body>
</soapenv:Envelope>`;
}
async function llamarSOAP(url, accion, sobre, timeoutMs = 45000) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `urn:${accion}` }, body: sobre, signal: ctl.signal });
    const body = await res.text();
    return { res, d: new DOMParser().parseFromString(body, 'text/xml') };
  } finally { clearTimeout(to); }
}
function faltaSOAP(d, res) {
  const faultcode = texto(d, 'faultcode'), faultstring = texto(d, 'faultstring'), detalle = texto(d, 'message') || texto(d, 'detail');
  const codigo = (faultcode.match(/(\d{4})/) || detalle.match(/INFO\s*:\s*(\d{4})/) || faultstring.match(/^(\d{4})$/) || [])[1] || faultcode || `HTTP ${res.status}`;
  const descripcion = (/^\d+$/.test(faultstring) ? detalle : faultstring.replace(/\s*-\s*Detalle:[\s\S]*$/, '')) || detalle || `HTTP ${res.status}`;
  const n = Number(codigo);
  return { estado: n >= 100 && n < 2000 ? 'ERROR' : 'RECHAZADO', codigo, descripcion, http: res.status };
}
const credenciales = (ruc, ambiente, usuarioSol, claveSol) => ambiente === 'beta' ? [`${ruc}MODDATOS`, 'MODDATOS'] : [`${ruc}${usuarioSol}`, claveSol];
/** Consulta un ticket de resumen o baja. statusCode 0 = procesado, 98 = en proceso, 99 = procesado con errores. */
async function consultarTicket({ ticket, ruc, ambiente = 'beta', usuarioSol, claveSol, endpoint, timeoutMs = 12000 }) {
  const [u, p] = credenciales(ruc, ambiente, usuarioSol, claveSol);
  const { res, d } = await llamarSOAP(endpoint || ENDPOINTS[ambiente], 'getStatus', sobreOp(u, p, `<ser:getStatus><ticket>${esc(ticket)}</ticket></ser:getStatus>`), timeoutMs);
  const statusCode = texto(d, 'statusCode'), content = texto(d, 'content');
  if (statusCode === '98') return { estado: 'EN_PROCESO', ticket, codigo: '98', descripcion: 'SUNAT aún procesa la comunicación de baja.' };
  if (content) {
    const cdr = await leerCDR(content), n = Number(cdr.codigo);
    return { estado: n === 0 ? (cdr.observaciones.length ? 'OBSERVADO' : 'ACEPTADO') : 'RECHAZADO', ticket, codigo: cdr.codigo, descripcion: cdr.descripcion, observaciones: cdr.observaciones, cdrZipBase64: content, statusCode };
  }
  if (!statusCode) return { ...faltaSOAP(d, res), ticket };
  return { estado: 'RECHAZADO', ticket, codigo: statusCode, descripcion: 'SUNAT procesó la baja con errores.', statusCode };
}
/** Envía una comunicación de baja (RA-AAAAMMDD-n) y espera su constancia. */
async function emitirBaja({ xml, ruc, id, ambiente = 'beta', usuarioSol, claveSol, keyPem, certPem, endpoint, intentos = 3, esperaMs = 1500, timeoutTicketMs = 8000 }) {
  const { xml: firmado, hash } = firmarXML(xml, { keyPem, certPem });
  const base = `${ruc}-${id}`, b64 = await zipBase64(`${base}.xml`, firmado);
  const [u, p] = credenciales(ruc, ambiente, usuarioSol, claveSol);
  const { res, d } = await llamarSOAP(endpoint || ENDPOINTS[ambiente], 'sendSummary', sobreOp(u, p, `<ser:sendSummary><fileName>${esc(base)}.zip</fileName><contentFile>${b64}</contentFile></ser:sendSummary>`));
  const ticket = texto(d, 'ticket');
  if (!ticket) return { ...faltaSOAP(d, res), hash, xmlFirmado: firmado };
  let r = { estado: 'EN_PROCESO', ticket, codigo: '98', descripcion: 'SUNAT recibió la baja y la está procesando.' };
  for (let i = 0; i < intentos; i++) {
    await esperar(esperaMs);
    try { r = await consultarTicket({ ticket, ruc, ambiente, usuarioSol, claveSol, endpoint, timeoutMs: timeoutTicketMs }); } catch (e) { r = { estado: 'EN_PROCESO', ticket, codigo: '98', descripcion: e.name === 'AbortError' ? 'SUNAT recibió la baja pero aún no responde la consulta del ticket. Consulta en unos minutos.' : e.message }; }
    if (r.estado !== 'EN_PROCESO') break;
  }
  return { ...r, ticket, hash, xmlFirmado: firmado };
}

/* =====================================================================
   Guía de remisión remitente (09) · API REST de SUNAT (OAuth2)
   No hay ambiente beta: se usa con las «Credenciales de API SUNAT» de producción.
   ===================================================================== */
const crypto = require('crypto');
const GRE = {
  token: process.env.SUNAT_GRE_TOKEN_URL || 'https://api-seguridad.sunat.gob.pe/v1/clientessol',
  api: process.env.SUNAT_GRE_API_URL || 'https://api-cpe.sunat.gob.pe/v1',
};
let tokenCache = { k: '', token: '', vence: 0 };
async function tokenGRE({ clientId, clientSecret, usuario, clave, timeoutMs = 20000 }) {
  const k = `${clientId}|${usuario}`;
  if (tokenCache.k === k && Date.now() < tokenCache.vence) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: 'password', scope: 'https://api-cpe.sunat.gob.pe', client_id: clientId, client_secret: clientSecret, username: usuario, password: clave });
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs);
  let r; try { r = await fetch(`${GRE.token}/${encodeURIComponent(clientId)}/oauth2/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: ctl.signal }); } finally { clearTimeout(to); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error(`Token GRE rechazado: ${j.error_description || j.msg || j.error || `HTTP ${r.status}`}`), { status: 401 });
  // el token dura poco: se reutiliza hasta un minuto antes de vencer
  tokenCache = { k, token: j.access_token, vence: Date.now() + Math.max(30, (Number(j.expires_in) || 300) - 60) * 1000 };
  return j.access_token;
}
async function consultarTicketGRE({ ticket, token }) {
  const r = await fetch(`${GRE.api}/contribuyente/gem/comprobantes/envios/${encodeURIComponent(ticket)}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.msg || `Consulta de ticket: HTTP ${r.status}`), { status: r.status });
  return j;
}
async function resultadoTicket(j, base) {
  const cod = String(j.codRespuesta ?? '');
  if (cod === '98') return { estado: 'EN_PROCESO', codigo: '98', descripcion: 'SUNAT aún procesa la guía.' };
  if (j.arcCdr) {
    const cdr = await leerCDR(j.arcCdr);
    const n = Number(cdr.codigo);
    return { estado: n === 0 ? (cdr.observaciones.length ? 'OBSERVADO' : 'ACEPTADO') : n >= 4000 ? 'OBSERVADO' : 'RECHAZADO', codigo: cdr.codigo, descripcion: cdr.descripcion, observaciones: cdr.observaciones, cdrZipBase64: j.arcCdr };
  }
  if (cod === '99') return { estado: 'RECHAZADO', codigo: String(j.error?.numError || '99'), descripcion: j.error?.desError || 'La guía tiene errores.' };
  return { estado: 'ERROR', codigo: cod || '—', descripcion: `Respuesta de SUNAT no reconocida para ${base}.` };
}
/**
 * Firma, comprime y envía la GRE; luego consulta el ticket hasta tener la constancia.
 * Si SUNAT sigue procesando, devuelve EN_PROCESO con el ticket: se vuelve a consultar, nunca se reenvía con otro número.
 */
async function emitirGRE({ xml, ruc, serie, numero, keyPem, certPem, clientId, clientSecret, usuarioSol, claveSol, ticketPrevio, intentos = 6, esperaMs = 2000 }) {
  if (!clientId || !clientSecret || !usuarioSol || !claveSol) throw Object.assign(new Error('Faltan SUNAT_GRE_CLIENT_ID, SUNAT_GRE_CLIENT_SECRET, SUNAT_USUARIO_SOL o SUNAT_CLAVE_SOL.'), { status: 412 });
  const base = `${ruc}-09-${serie}-${numero}`;
  const token = await tokenGRE({ clientId, clientSecret, usuario: `${ruc}${usuarioSol}`, clave: claveSol });
  let ticket = ticketPrevio, firmado = '', hash = '';
  if (!ticket) {
    ({ xml: firmado, hash } = firmarXML(xml, { keyPem, certPem }));
    const z = new JSZip(); z.file(`${base}.xml`, firmado);
    const buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const r = await fetch(`${GRE.api}/contribuyente/gem/comprobantes/${base}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ archivo: { nomArchivo: `${base}.zip`, arcGreZip: buf.toString('base64'), hashZip: crypto.createHash('sha256').update(buf).digest('hex') } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.numTicket) {
      const e0 = (j.errors && j.errors[0]) || {};
      return { estado: r.status >= 500 ? 'ERROR' : 'RECHAZADO', codigo: String(e0.cod || j.cod || r.status), descripcion: e0.msg || j.msg || `SUNAT respondió ${r.status}`, observaciones: [], hash, xmlFirmado: firmado };
    }
    ticket = j.numTicket;
  }
  for (let i = 0; i < intentos; i++) {
    await esperar(i === 0 ? 800 : esperaMs);
    const res = await resultadoTicket(await consultarTicketGRE({ ticket, token }), base);
    if (res.estado !== 'EN_PROCESO') return { ...res, ticket, hash, xmlFirmado: firmado };
  }
  return { estado: 'EN_PROCESO', codigo: '98', descripcion: 'SUNAT aún procesa la guía.', ticket, hash, xmlFirmado: firmado };
}

module.exports = { emitirBaja, consultarTicket, emitir, emitirGRE, consultarTicketGRE, tokenGRE, firmarXML, leerCDR, ENDPOINTS, GRE };
