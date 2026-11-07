'use strict';
/* =====================================================================
   Granate · Cotiza y Factura — núcleo (sin DOM en el nivel superior)
   ===================================================================== */

/* ---------- utilidades ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n, l) => String(n).padStart(l, '0');
const uid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));
const isoOf = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1, 2)}-${pad(dt.getDate(), 2)}`;
const todayISO = () => isoOf(new Date());
const nowTime = () => { const d = new Date(); return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`; };
const parseISO = iso => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const addMonths = (iso, n) => { const d = parseISO(iso); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return isoOf(d); };
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtDate = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const fmtDay = iso => { if (!iso) return '—'; const d = parseISO(iso); return `${pad(d.getDate(), 2)} ${MES3[d.getMonth()]}`; };
const nf2 = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 });
const curSym = c => (c === 'USD' ? 'US$' : 'S/');
const money = (n, c = 'PEN') => `${curSym(c)} ${nf2.format(Number(n) || 0)}`;
const money0 = (n, c = 'PEN') => `${curSym(c)} ${nf0.format(Number(n) || 0)}`;
const compact = n => { const a = Math.abs(n); if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace('.0', '')} M`; if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace('.0', '')} mil`; return nf0.format(n); };
const initials = s => String(s || '?').replace(/\b(S\.?A\.?C?\.?|E\.?I\.?R\.?L\.?|S\.?R\.?L\.?|S\.?A\.?A\.?)\b/gi, '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const decStr = (n, min = 2, max = 10) => { const s = Number(n).toFixed(max).replace(/0+$/, ''); const [i, f = ''] = s.split('.'); return `${i}.${f.padEnd(min, '0')}`; };

/* ---------- catálogos SUNAT ---------- */
const TIPOS = {
  COT: { corto: 'Cotización', impreso: 'Cotización', sunat: null, plural: 'Cotizaciones' },
  '01': { corto: 'Factura', impreso: 'Factura electrónica', sunat: 'Factura', plural: 'Facturas' },
  '03': { corto: 'Boleta', impreso: 'Boleta de venta electrónica', sunat: 'Boleta', plural: 'Boletas' },
  '07': { corto: 'Nota de crédito', impreso: 'Nota de crédito electrónica', sunat: 'Nota de Credito', plural: 'Notas de crédito' },
};
const DOCID = { '6': 'RUC', '1': 'DNI', '4': 'C.E.', '7': 'Pasaporte', '0': 'Sin doc.' };
const UNIDADES = { NIU: 'Unidad', ZZ: 'Servicio', HUR: 'Hora', KGM: 'Kilogramo', MTR: 'Metro', BX: 'Caja' };
const AFECT = { '10': 'Gravado', '20': 'Exonerado', '30': 'Inafecto' };
const MOTIVOS_NC = {
  '01': 'Anulación de la operación', '02': 'Anulación por error en el RUC', '03': 'Corrección por error en la descripción',
  '06': 'Devolución total', '07': 'Devolución por ítem', '09': 'Disminución en el valor',
};
const IGV_OPTS = [{ v: 0.18, l: '18% · Tasa general (IGV 15.5% + IPM 2.5%)' }, { v: 0.105, l: '10.5% · MYPE restaurantes y hoteles (2026)' }];

const SUNAT_EP = [
  ['Emisión (beta)', 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService', 'SOAP · sendBill con ZIP del XML firmado'],
  ['Emisión (producción)', 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService', 'SOAP · facturas, boletas, notas, resúmenes y bajas'],
  ['Consulta de CDR', 'https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService', 'SOAP · recuperar la constancia de un comprobante'],
  ['Token API (validez)', 'https://api-seguridad.sunat.gob.pe/v1/clientesextranet/{client_id}/oauth2/token/', 'OAuth2 client credentials (Credenciales de API SUNAT)'],
  ['Validez de comprobantes', 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/{ruc}/validarcomprobante', 'REST · estado aceptado / anulado / no informado'],
];

/* ---------- validaciones ---------- */
function validRUC(r) {
  r = String(r || '').trim();
  if (!/^(10|15|16|17|20)\d{9}$/.test(r)) return false;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0; for (let i = 0; i < 10; i++) s += Number(r[i]) * w[i];
  let c = 11 - (s % 11); if (c === 10) c = 0; if (c === 11) c = 1;
  return c === Number(r[10]);
}
function validDocId(tipo, n) {
  n = String(n || '').trim();
  if (tipo === '6') return validRUC(n);
  if (tipo === '1') return /^\d{8}$/.test(n);
  if (tipo === '4') return /^[A-Za-z0-9]{6,12}$/.test(n);
  if (tipo === '7') return /^[A-Za-z0-9]{5,12}$/.test(n);
  return true;
}

/* ---------- cálculo de importes ---------- */
function calc(doc) {
  const rate = Number(doc.igvRate ?? 0.18);
  let grav = 0, exo = 0, ina = 0, igv = 0;
  const lines = (doc.items || []).map(it => {
    const q = Number(it.cant) || 0, p = Number(it.precio) || 0;
    let valor, ig, total, vu, pu;
    if ((it.afect || '10') === '10') {
      if (doc.incluyeIGV) { total = r2(q * p); valor = r2(total / (1 + rate)); ig = r2(total - valor); vu = p / (1 + rate); pu = p; }
      else { valor = r2(q * p); ig = r2(valor * rate); total = r2(valor + ig); vu = p; pu = p * (1 + rate); }
      grav += valor;
    } else {
      valor = r2(q * p); ig = 0; total = valor; vu = p; pu = p;
      if (it.afect === '20') exo += valor; else ina += valor;
    }
    igv += ig;
    return { ...it, q, valor, igv: ig, total, vu, pu };
  });
  grav = r2(grav); exo = r2(exo); ina = r2(ina); igv = r2(igv);
  return { lines, gravada: grav, exonerada: exo, inafecta: ina, igv, total: r2(grav + exo + ina + igv), rate };
}

/* ---------- monto en letras ---------- */
function numeroALetras(num, moneda = 'PEN') {
  const UN = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDÓS', 'VEINTITRÉS', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISÉIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
  const DEC = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const CEN = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
  const apoc = s => s.replace(/VEINTIUNO$/, 'VEINTIÚN').replace(/UNO$/, 'UN');
  const dos = n => (n < 30 ? UN[n] : DEC[Math.floor(n / 10)] + (n % 10 ? ' Y ' + UN[n % 10] : ''));
  const tres = n => { if (n === 100) return 'CIEN'; const c = Math.floor(n / 100), r = n % 100; return [c ? CEN[c] : '', r ? dos(r) : ''].filter(Boolean).join(' '); };
  const miles = n => { const m = Math.floor(n / 1000), r = n % 1000; return [m ? (m === 1 ? 'MIL' : apoc(tres(m)) + ' MIL') : '', r ? tres(r) : ''].filter(Boolean).join(' '); };
  const millones = n => { const m = Math.floor(n / 1e6), r = n % 1e6; return [m ? (m === 1 ? 'UN MILLÓN' : apoc(miles(m)) + ' MILLONES') : '', r ? miles(r) : ''].filter(Boolean).join(' '); };
  const cents = Math.round(Math.abs(Number(num) || 0) * 100);
  const ent = Math.floor(cents / 100), dec = cents % 100;
  const letras = ent === 0 ? 'CERO' : millones(ent);
  return `${letras} CON ${pad(dec, 2)}/100 ${moneda === 'USD' ? 'DÓLARES AMERICANOS' : 'SOLES'}`;
}

/* ---------- numeración ---------- */
const docNum = d => (d.numero ? `${d.serie}-${pad(d.numero, d.tipo === 'COT' ? 6 : 8)}` : `${d.serie}-borrador`);
const docIdSunat = d => `${d.serie}-${d.numero}`;
const fileBase = (d, ruc) => `${ruc}-${d.tipo}-${d.serie}-${d.numero}`;

/* ---------- configuración por defecto ---------- */
function defaultConfig() {
  return {
    empresa: { ruc: '', razon: '', comercial: '', direccion: '', ubigeo: '', distrito: '', provincia: '', departamento: '', telefono: '', email: '', cuentas: '' },
    series: { '01': 'F001', '03': 'B001', '07F': 'FC01', '07B': 'BC01', COT: 'C001' },
    igvRate: 0.18, incluyeIGV: false, tipoCambio: 3.5, validezDias: 15,
    condiciones: 'Precios en la moneda indicada. Tiempo de entrega a coordinar desde la orden de compra.',
    integracion: { modo: 'simulador', url: '', ambiente: 'beta' },
    docs: defaultDocs(),
  };
}
/* ---------- personalización de documentos ---------- */
const BLOQUES = {
  cot: {
    cliente: { label: 'Datos del cliente', desc: 'Razón social, documento, dirección y fechas', req: true },
    items: { label: 'Detalle de productos', desc: 'Tabla de ítems', req: true },
    totales: { label: 'Totales y monto en letras', desc: 'Op. gravadas, IGV y total', req: true },
    condiciones: { label: 'Condiciones comerciales', desc: 'Entrega, garantía, forma de pago' },
    cuentas: { label: 'Cuentas bancarias', desc: 'Para depósito o transferencia' },
    obs: { label: 'Observaciones', desc: 'Notas del documento' },
    firma: { label: 'Firma', desc: 'Nombre y cargo de quien cotiza' },
  },
  fac: {
    cliente: { label: 'Datos del cliente', desc: 'Exigido en la representación impresa', req: true },
    items: { label: 'Detalle de productos', desc: 'Tabla de ítems', req: true },
    totales: { label: 'Totales y monto en letras', desc: 'Exigido en la representación impresa', req: true },
    pago: { label: 'Crédito y detracción', desc: 'Cuotas al crédito y cuenta del Banco de la Nación', req: true },
    cuentas: { label: 'Cuentas bancarias', desc: 'Para que te paguen más rápido' },
    obs: { label: 'Observaciones', desc: 'Orden de compra, guía, notas' },
  },
};
function defaultDocs() {
  return {
    color: '#7A1F2E',
    cuentas: [],
    detraccion: '', mostrarDetraccion: true,
    cot: { titulo: 'Cotización', orden: Object.keys(BLOQUES.cot), ocultos: [], mostrarCodigo: true, mostrarUnidad: true, pie: 'Gracias por considerarnos. Quedamos atentos a su confirmación.', firmaNombre: '', firmaCargo: '' },
    fac: { orden: Object.keys(BLOQUES.fac), ocultos: [], mostrarCodigo: false, mostrarUnidad: true, pie: 'Gracias por su preferencia.' },
  };
}
function mergeDocs(o) {
  const d = defaultDocs(); o = o || {};
  const fix = (tipo, v) => {
    const m = { ...d[tipo], ...(v || {}) };
    const keys = Object.keys(BLOQUES[tipo]);
    m.orden = [...(m.orden || []).filter(k => keys.includes(k)), ...keys.filter(k => !(m.orden || []).includes(k))];
    m.ocultos = (m.ocultos || []).filter(k => keys.includes(k) && !BLOQUES[tipo][k].req);
    return m;
  };
  return { ...d, ...o, cuentas: Array.isArray(o.cuentas) ? o.cuentas : [], cot: fix('cot', o.cot), fac: fix('fac', o.fac) };
}
function mergeCfg(c) {
  const d = defaultConfig(); if (!c) return d;
  const o = clone(c);
  return { ...d, ...o, empresa: { ...d.empresa, ...(o.empresa || {}) }, series: { ...d.series, ...(o.series || {}) }, integracion: { ...d.integracion, ...(o.integracion || {}) }, docs: mergeDocs(o.docs) };
}
const empresaLista = cfg => validRUC(cfg.empresa.ruc) && cfg.empresa.razon.trim().length > 2 && cfg.empresa.direccion.trim().length > 3;

/* ---------- reglas de emisión (las mismas que valida SUNAT en lo esencial) ---------- */
function validarDoc(doc, cfg, toPEN) {
  const e = [];
  const isCPE = doc.tipo !== 'COT';
  const cli = doc.cliente || {};
  if (isCPE && !empresaLista(cfg)) e.push('Completa RUC, razón social y dirección fiscal de tu empresa en «Integración SUNAT».');
  if (!cli.nombre || cli.nombre.trim().length < 2) e.push('Indica el cliente (nombre o razón social).');
  if (doc.tipo === '01' && cli.tipoDoc !== '6') e.push('Una factura exige que el cliente se identifique con RUC. Para DNI emite una boleta.');
  if (cli.nombre && cli.tipoDoc && cli.tipoDoc !== '0' && !validDocId(cli.tipoDoc, cli.numDoc)) e.push(cli.tipoDoc === '6' ? 'El RUC del cliente no es válido (revisa el dígito verificador).' : `El ${DOCID[cli.tipoDoc]} del cliente no tiene un formato válido.`);
  if (!(doc.items || []).length) e.push('Agrega al menos un producto o servicio.');
  (doc.items || []).forEach((it, i) => {
    if (!String(it.desc || '').trim()) e.push(`La línea ${i + 1} no tiene descripción.`);
    if (!(Number(it.cant) > 0)) e.push(`La cantidad de la línea ${i + 1} debe ser mayor a cero.`);
    if (!(Number(it.precio) >= 0)) e.push(`El precio de la línea ${i + 1} no es válido.`);
  });
  const c = calc(doc);
  if (isCPE && c.total <= 0) e.push('El importe total debe ser mayor a cero.');
  if (doc.tipo === '03' && (cli.tipoDoc === '0' || !cli.tipoDoc) && toPEN(c.total, doc.moneda) > 700) e.push('Las boletas mayores a S/ 700 deben identificar al cliente con DNI, RUC o C.E.');
  if (doc.tipo === '01' && doc.formaPago === 'Credito') {
    const cuotas = doc.cuotas || [];
    if (!cuotas.length) e.push('Una factura al crédito necesita al menos una cuota.');
    const sum = r2(cuotas.reduce((a, q) => a + (Number(q.monto) || 0), 0));
    if (cuotas.length && Math.abs(sum - c.total) > 0.01) e.push(`Las cuotas suman ${money(sum, doc.moneda)} y deben sumar el total ${money(c.total, doc.moneda)}.`);
    cuotas.forEach((q, i) => { if (!q.fecha || q.fecha <= doc.fecha) e.push(`La cuota ${i + 1} debe vencer después de la fecha de emisión.`); });
  }
  if (doc.tipo === '07') {
    if (!doc.ref || !doc.ref.serie) e.push('La nota de crédito debe referenciar el comprobante que modifica.');
    if (!doc.ref?.motivo) e.push('Elige el motivo de la nota de crédito.');
    if (!String(doc.ref?.sustento || '').trim()) e.push('Escribe el sustento de la nota de crédito.');
  }
  if (isCPE && doc.fecha > todayISO()) e.push('La fecha de emisión no puede ser futura.');
  return e;
}

/* ---------- XML UBL 2.1 (estructura SUNAT, sin firma) ---------- */
function buildXML(doc, cfg) {
  const c = calc(doc), e = cfg.empresa, cli = doc.cliente || {};
  const cur = doc.moneda || 'PEN', A = `currencyID="${cur}"`;
  const isNC = doc.tipo === '07';
  const root = isNC ? 'CreditNote' : 'Invoice';
  const X = s => esc(s);
  const cd = s => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  const id = docIdSunat(doc);
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(`<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">`);
  L.push('  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><!-- Aquí va la firma XMLDSig (certificado digital) que agrega tu backend --></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>');
  L.push('  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>', '  <cbc:CustomizationID>2.0</cbc:CustomizationID>');
  L.push(`  <cbc:ID>${X(id)}</cbc:ID>`, `  <cbc:IssueDate>${doc.fecha}</cbc:IssueDate>`, `  <cbc:IssueTime>${doc.hora || '00:00:00'}</cbc:IssueTime>`);
  if (!isNC) {
    if (doc.vence) L.push(`  <cbc:DueDate>${doc.vence}</cbc:DueDate>`);
    L.push(`  <cbc:InvoiceTypeCode listID="0101">${doc.tipo}</cbc:InvoiceTypeCode>`);
  }
  L.push(`  <cbc:Note languageLocaleID="1000">${cd(numeroALetras(c.total, cur))}</cbc:Note>`);
  L.push(`  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`);
  if (isNC && doc.ref) {
    const refId = `${doc.ref.serie}-${doc.ref.numero}`;
    L.push('  <cac:DiscrepancyResponse>', `    <cbc:ReferenceID>${X(refId)}</cbc:ReferenceID>`, `    <cbc:ResponseCode>${X(doc.ref.motivo)}</cbc:ResponseCode>`, `    <cbc:Description>${cd(doc.ref.sustento)}</cbc:Description>`, '  </cac:DiscrepancyResponse>');
    L.push('  <cac:BillingReference><cac:InvoiceDocumentReference>', `    <cbc:ID>${X(refId)}</cbc:ID>`, `    <cbc:DocumentTypeCode>${X(doc.ref.tipo)}</cbc:DocumentTypeCode>`, '  </cac:InvoiceDocumentReference></cac:BillingReference>');
  }
  L.push('  <cac:Signature>', `    <cbc:ID>${X(e.ruc)}</cbc:ID>`, `    <cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${X(e.ruc)}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${cd(e.razon)}</cbc:Name></cac:PartyName></cac:SignatoryParty>`, '    <cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SignatureSP</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>', '  </cac:Signature>');
  L.push('  <cac:AccountingSupplierParty><cac:Party>', `    <cac:PartyIdentification><cbc:ID schemeID="6">${X(e.ruc)}</cbc:ID></cac:PartyIdentification>`, `    <cac:PartyName><cbc:Name>${cd(e.comercial || e.razon)}</cbc:Name></cac:PartyName>`, `    <cac:PartyLegalEntity><cbc:RegistrationName>${cd(e.razon)}</cbc:RegistrationName>`, `      <cac:RegistrationAddress><cbc:ID>${X(e.ubigeo)}</cbc:ID><cbc:AddressTypeCode>0000</cbc:AddressTypeCode><cbc:CityName>${cd(e.provincia)}</cbc:CityName><cbc:CountrySubentity>${cd(e.departamento)}</cbc:CountrySubentity><cbc:District>${cd(e.distrito)}</cbc:District><cac:AddressLine><cbc:Line>${cd(e.direccion)}</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>`, '    </cac:PartyLegalEntity>', '  </cac:Party></cac:AccountingSupplierParty>');
  L.push('  <cac:AccountingCustomerParty><cac:Party>', `    <cac:PartyIdentification><cbc:ID schemeID="${X(cli.tipoDoc || '0')}">${X(cli.tipoDoc === '0' ? '-' : cli.numDoc)}</cbc:ID></cac:PartyIdentification>`, `    <cac:PartyLegalEntity><cbc:RegistrationName>${cd(cli.nombre)}</cbc:RegistrationName>${cli.direccion ? `<cac:RegistrationAddress><cac:AddressLine><cbc:Line>${cd(cli.direccion)}</cbc:Line></cac:AddressLine></cac:RegistrationAddress>` : ''}</cac:PartyLegalEntity>`, '  </cac:Party></cac:AccountingCustomerParty>');
  if (doc.tipo === '01') {
    if (doc.formaPago === 'Credito') {
      L.push(`  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Credito</cbc:PaymentMeansID><cbc:Amount ${A}>${c.total.toFixed(2)}</cbc:Amount></cac:PaymentTerms>`);
      (doc.cuotas || []).forEach((q, i) => L.push(`  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Cuota${pad(i + 1, 3)}</cbc:PaymentMeansID><cbc:Amount ${A}>${Number(q.monto).toFixed(2)}</cbc:Amount><cbc:PaymentDueDate>${q.fecha}</cbc:PaymentDueDate></cac:PaymentTerms>`));
    } else L.push('  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>');
  }
  const sub = (base, tax, code, name, type) => `    <cac:TaxSubtotal><cbc:TaxableAmount ${A}>${base.toFixed(2)}</cbc:TaxableAmount><cbc:TaxAmount ${A}>${tax.toFixed(2)}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>${code}</cbc:ID><cbc:Name>${name}</cbc:Name><cbc:TaxTypeCode>${type}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  L.push('  <cac:TaxTotal>', `    <cbc:TaxAmount ${A}>${c.igv.toFixed(2)}</cbc:TaxAmount>`);
  if (c.gravada || (!c.exonerada && !c.inafecta)) L.push(sub(c.gravada, c.igv, '1000', 'IGV', 'VAT'));
  if (c.exonerada) L.push(sub(c.exonerada, 0, '9997', 'EXO', 'VAT'));
  if (c.inafecta) L.push(sub(c.inafecta, 0, '9998', 'INA', 'FRE'));
  L.push('  </cac:TaxTotal>');
  L.push('  <cac:LegalMonetaryTotal>', `    <cbc:LineExtensionAmount ${A}>${r2(c.gravada + c.exonerada + c.inafecta).toFixed(2)}</cbc:LineExtensionAmount>`, `    <cbc:TaxInclusiveAmount ${A}>${c.total.toFixed(2)}</cbc:TaxInclusiveAmount>`, `    <cbc:PayableAmount ${A}>${c.total.toFixed(2)}</cbc:PayableAmount>`, '  </cac:LegalMonetaryTotal>');
  const lineTag = isNC ? 'CreditNoteLine' : 'InvoiceLine', qtyTag = isNC ? 'CreditedQuantity' : 'InvoicedQuantity';
  c.lines.forEach((l, i) => {
    const af = l.afect || '10';
    const scheme = af === '10' ? ['1000', 'IGV', 'VAT'] : af === '20' ? ['9997', 'EXO', 'VAT'] : ['9998', 'INA', 'FRE'];
    L.push(`  <cac:${lineTag}>`, `    <cbc:ID>${i + 1}</cbc:ID>`, `    <cbc:${qtyTag} unitCode="${X(l.unidad || 'NIU')}">${decStr(l.q, 0, 10).replace(/\.$/, '')}</cbc:${qtyTag}>`, `    <cbc:LineExtensionAmount ${A}>${l.valor.toFixed(2)}</cbc:LineExtensionAmount>`, `    <cac:PricingReference><cac:AlternativeConditionPrice><cbc:PriceAmount ${A}>${decStr(l.pu, 2, 6)}</cbc:PriceAmount><cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>`);
    L.push('    <cac:TaxTotal>', `      <cbc:TaxAmount ${A}>${l.igv.toFixed(2)}</cbc:TaxAmount>`, `      <cac:TaxSubtotal><cbc:TaxableAmount ${A}>${l.valor.toFixed(2)}</cbc:TaxableAmount><cbc:TaxAmount ${A}>${l.igv.toFixed(2)}</cbc:TaxAmount><cac:TaxCategory><cbc:Percent>${af === '10' ? r2(c.rate * 100) : 0}</cbc:Percent><cbc:TaxExemptionReasonCode>${af}</cbc:TaxExemptionReasonCode><cac:TaxScheme><cbc:ID>${scheme[0]}</cbc:ID><cbc:Name>${scheme[1]}</cbc:Name><cbc:TaxTypeCode>${scheme[2]}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`, '    </cac:TaxTotal>');
    L.push(`    <cac:Item><cbc:Description>${cd(l.desc)}</cbc:Description>${l.codigo ? `<cac:SellersItemIdentification><cbc:ID>${X(l.codigo)}</cbc:ID></cac:SellersItemIdentification>` : ''}</cac:Item>`, `    <cac:Price><cbc:PriceAmount ${A}>${decStr(l.vu, 2, 6)}</cbc:PriceAmount></cac:Price>`, `  </cac:${lineTag}>`);
  });
  L.push(`</${root}>`);
  return L.join('\n');
}

/* Texto del QR de la representación impresa */
const qrText = (d, cfg, c) => [cfg.empresa.ruc, d.tipo, d.serie, d.numero, c.igv.toFixed(2), c.total.toFixed(2), fmtDate(d.fecha), d.cliente?.tipoDoc || '0', d.cliente?.tipoDoc === '0' ? '-' : d.cliente?.numDoc || '-', d.sunat?.hash || ''].join('|') + '|';

async function sha256b64(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    let s = ''; new Uint8Array(buf).forEach(b => (s += String.fromCharCode(b)));
    return btoa(s).slice(0, 28);
  } catch { return uid().slice(0, 28); }
}

/* ---------- datos de demostración (ficticios) ---------- */
function buildSeed(today) {
  const cfg = defaultConfig();
  cfg.empresa = { ruc: '20000000001', razon: 'Comercial Granate Demo S.A.C.', comercial: 'Granate Demo', direccion: 'Av. Ejemplo 123, Of. 401', ubigeo: '150131', distrito: 'San Isidro', provincia: 'Lima', departamento: 'Lima', telefono: '(01) 000 0000', email: 'ventas@empresa-demo.pe', cuentas: '' };
  cfg.docs.cuentas = [
    { banco: 'BCP', tipo: 'Corriente', moneda: 'PEN', numero: '000-0000000-0-00', cci: '00200000000000000000', enCot: true, enFac: true },
    { banco: 'Interbank', tipo: 'Corriente', moneda: 'USD', numero: '000-0000000000', cci: '00300000000000000000', enCot: true, enFac: true },
  ];
  cfg.docs.detraccion = '00-000-000000';
  cfg.docs.cot.firmaNombre = 'Equipo comercial'; cfg.docs.cot.firmaCargo = 'Granate Demo';
  const C = [
    { tipoDoc: '6', numDoc: '20000000028', nombre: 'Constructora Demo Norte S.A.C.', direccion: 'Av. Demo 456, Trujillo, La Libertad', email: 'compras@constructora-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '20000000036', nombre: 'Agroexportadora Demo Sur S.A.', direccion: 'Panamericana Sur km 300, Ica', email: 'logistica@agro-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '20000000044', nombre: 'Distribuidora Demo Centro S.R.L.', direccion: 'Jr. Ejemplo 789, Huancayo, Junín', email: 'pagos@distribuidora-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '20000000052', nombre: 'Inversiones Demo Lima E.I.R.L.', direccion: 'Calle Muestra 321, Miraflores, Lima', email: 'gerencia@inversiones-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '10000000014', nombre: 'Ana Pérez Rojas (demo)', direccion: 'Av. Prueba 100, Surco, Lima', email: '', telefono: '' },
    { tipoDoc: '1', numDoc: '00000001', nombre: 'Carlos Mendoza (demo)', direccion: '', email: '', telefono: '' },
  ].map(c => ({ ...c, id: uid(), demo: true }));
  const P = [
    { codigo: 'P001', desc: 'Consultoría especializada (hora)', unidad: 'HUR', precio: 180, afect: '10' },
    { codigo: 'P002', desc: 'Implementación de dashboard BI', unidad: 'ZZ', precio: 4800, afect: '10' },
    { codigo: 'P003', desc: 'Licencia plataforma analítica (usuario/mes)', unidad: 'ZZ', precio: 95, afect: '10' },
    { codigo: 'P004', desc: 'Taller de capacitación in-house (8 h)', unidad: 'ZZ', precio: 2200, afect: '10' },
    { codigo: 'P005', desc: 'Laptop 14" Core i7 · 16 GB · 512 GB SSD', unidad: 'NIU', precio: 3650, afect: '10' },
    { codigo: 'P006', desc: 'Monitor 27" QHD', unidad: 'NIU', precio: 980, afect: '10' },
    { codigo: 'P007', desc: 'Soporte y mantenimiento mensual', unidad: 'ZZ', precio: 1150, afect: '10' },
  ].map(p => ({ ...p, id: uid(), demo: true }));
  const docs = [];
  const cliSnap = i => { const c = C[i]; return { id: c.id, tipoDoc: c.tipoDoc, numDoc: c.numDoc, nombre: c.nombre, direccion: c.direccion, email: c.email, telefono: c.telefono }; };
  const items = arr => arr.map(([pi, q]) => ({ id: uid(), codigo: P[pi].codigo, desc: P[pi].desc, unidad: P[pi].unidad, cant: q, precio: P[pi].precio, afect: '10' }));
  const mk = (tipo, numero, ago, ci, its, extra = {}) => {
    const fecha = addDays(today, -ago);
    const serie = tipo === 'COT' ? cfg.series.COT : tipo === '07' ? cfg.series['07F'] : cfg.series[tipo];
    const d = { id: uid(), tipo, serie, numero, fecha, hora: '10:30:00', moneda: 'PEN', incluyeIGV: false, igvRate: 0.18, cliente: cliSnap(ci), items: items(its), formaPago: 'Contado', cuotas: [], obs: '', estado: tipo === 'COT' ? 'enviada' : 'aceptado', creado: fecha + 'T10:30:00', demo: true, ...extra };
    if (tipo === 'COT') { d.vence = d.vence || addDays(fecha, 15); d.condiciones = cfg.condiciones; }
    d.totales = (({ gravada, exonerada, inafecta, igv, total }) => ({ gravada, exonerada, inafecta, igv, total }))(calc(d));
    if (tipo !== 'COT' && d.estado === 'aceptado') d.sunat = { estado: 'aceptado', codigo: '0', descripcion: `La ${TIPOS[tipo].sunat} numero ${serie}-${numero}, ha sido aceptada`, hash: (uid() + uid()).slice(0, 28), fecha: fecha + 'T10:31:00', modo: 'simulador', ambiente: 'beta' };
    docs.push(d); return d;
  };
  const link = (cot, f) => { cot.estado = 'facturada'; cot.facturaId = f.id; f.origenId = cot.id; };
  const c1 = mk('COT', 1, 175, 0, [[1, 1], [0, 10]]);
  const f1 = mk('01', 1, 165, 0, [[1, 1], [0, 10]], { cobrado: true }); link(c1, f1);
  mk('01', 2, 150, 1, [[4, 3]], { cobrado: true });
  const c2 = mk('COT', 2, 100, 0, [[6, 1]]);
  mk('01', 3, 128, 3, [[6, 1]], { cobrado: true });
  mk('01', 4, 120, 2, [[3, 1], [2, 10]], { cobrado: true });
  const f5 = mk('01', 5, 95, 0, [[6, 1]], { cobrado: true }); link(c2, f5);
  const c3 = mk('COT', 3, 92, 1, [[1, 1]]);
  const f6 = mk('01', 6, 88, 1, [[1, 1]], { cobrado: true }); link(c3, f6);
  const f7 = mk('01', 7, 70, 3, [[4, 2], [5, 2]], { cobrado: true });
  const nc = mk('07', 1, 64, 3, [[5, 1]]);
  nc.ref = { id: f7.id, tipo: '01', serie: f7.serie, numero: f7.numero, motivo: '07', sustento: 'Devolución de un monitor por falla de fábrica.' };
  mk('01', 8, 60, 2, [[6, 1]], { cobrado: true });
  mk('03', 1, 50, 5, [[5, 1]], { serie: 'B001', cliente: cliSnap(5) });
  const f9 = mk('01', 9, 45, 0, [[0, 24]], { formaPago: 'Credito' });
  f9.cuotas = [{ monto: f9.totales.total, fecha: addDays(f9.fecha, 30) }]; f9.vence = f9.cuotas[0].fecha; f9.cobrado = false;
  const c4 = mk('COT', 4, 40, 1, [[1, 1], [3, 1]]);
  const f10 = mk('01', 10, 33, 1, [[1, 1], [3, 1]], { cobrado: true }); link(c4, f10);
  mk('COT', 5, 26, 2, [[1, 1]], { estado: 'rechazada' });
  mk('01', 11, 20, 3, [[2, 25], [6, 1]], { cobrado: true });
  mk('COT', 6, 14, 3, [[1, 1], [3, 1]], { estado: 'aprobada' });
  mk('COT', 7, 13, 0, [[0, 40]], { estado: 'enviada' });
  mk('COT', 8, 10, 2, [[4, 4], [5, 4]], { estado: 'enviada' });
  const f12 = mk('01', 12, 9, 2, [[4, 1], [5, 1]], { formaPago: 'Credito' });
  const half = r2(f12.totales.total / 2);
  f12.cuotas = [{ monto: half, fecha: addDays(f12.fecha, 30) }, { monto: r2(f12.totales.total - half), fecha: addDays(f12.fecha, 60) }]; f12.vence = f12.cuotas[1].fecha; f12.cobrado = false;
  mk('03', 2, 6, 5, [[2, 2]], { serie: 'B001', cliente: { id: '', tipoDoc: '0', numDoc: '', nombre: 'Clientes varios', direccion: '', email: '', telefono: '' } });
  mk('01', 13, 4, 0, [[0, 8]], { cobrado: true });
  mk('COT', 9, 3, 1, [[1, 1], [2, 20]], { estado: 'enviada' });
  const fr = mk('01', 14, 2, 4, [[0, 6]], { estado: 'rechazado' });
  fr.sunat = { estado: 'rechazado', codigo: '—', descripcion: 'Rechazo de ejemplo: el receptor no figura activo en el padrón. Corrige y emite un nuevo comprobante.', hash: '', fecha: fr.fecha + 'T11:02:00', modo: 'simulador', ambiente: 'beta' };
  mk('01', 15, 1, 1, [[6, 1]], { estado: 'pendiente' });
  mk('COT', 10, 0, 3, [[2, 15]], { estado: 'borrador' });
  return { cfg, clientes: C, productos: P, documentos: docs };
}

if (typeof module !== 'undefined') module.exports = { BLOQUES, defaultDocs, mergeDocs, calc, numeroALetras, validRUC, buildXML, buildSeed, defaultConfig, validarDoc, docNum, qrText, money };
