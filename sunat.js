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

module.exports = { emitir, firmarXML, leerCDR, ENDPOINTS };
