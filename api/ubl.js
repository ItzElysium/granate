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
  '08': { corto: 'Nota de débito', impreso: 'Nota de débito electrónica', sunat: 'Nota de Debito', plural: 'Notas de débito' },
  '09': { corto: 'Guía de remisión', impreso: 'Guía de remisión remitente electrónica', sunat: 'Guia de Remision', plural: 'Guías de remisión' },
  NV: { corto: 'Nota de venta', impreso: 'Nota de venta', sunat: null, plural: 'Notas de venta' },
};
/* 01/03/07/08 viajan por billService (SOAP); 09 por la API REST de GRE; NV y COT no se declaran */
const ES_CPE = t => ['01', '03', '07', '08'].includes(t);
const ES_NOTA = t => t === '07' || t === '08';
const ES_SUNAT = t => ES_CPE(t) || t === '09';
const DOCID = { '6': 'RUC', '1': 'DNI', '4': 'C.E.', '7': 'Pasaporte', '0': 'Sin doc.' };
const UNIDADES = { NIU: 'Unidad', ZZ: 'Servicio', HUR: 'Hora', KGM: 'Kilogramo', MTR: 'Metro', BX: 'Caja', TNE: 'Tonelada', LTR: 'Litro' };
const UNIDADES_SERV = ['ZZ', 'HUR'];
const AFECT = { '10': 'Gravado', '20': 'Exonerado', '30': 'Inafecto' };
const MOTIVOS_NC = {
  '01': 'Anulación de la operación', '02': 'Anulación por error en el RUC', '03': 'Corrección por error en la descripción',
  '06': 'Devolución total', '07': 'Devolución por ítem', '09': 'Disminución en el valor',
};
/* catálogo 10: motivos de la nota de débito */
const MOTIVOS_ND = { '01': 'Intereses por mora', '02': 'Aumento en el valor', '03': 'Penalidades / otros conceptos' };
/* catálogo 20: motivo de traslado (GRE 2022) — se excluyen importación/exportación (exigen puerto o DAM) */
const MOTIVOS_TRASLADO = {
  '01': 'Venta', '14': 'Venta sujeta a confirmación del comprador', '03': 'Venta con entrega a terceros',
  '04': 'Traslado entre establecimientos de la misma empresa', '05': 'Consignación', '06': 'Devolución', '02': 'Compra', '13': 'Otros',
};
/* catálogo 18: modalidad de traslado */
const MODALIDAD = { '02': 'Transporte privado', '01': 'Transporte público' };
/* catálogo 61: documento relacionado al transporte */
const DOC_REL_GRE = { '01': 'Factura', '03': 'Boleta de venta' };
/* catálogo 54 · SPOT (R.S. 183-2004/SUNAT, anexos 2 y 3): el porcentaje va ligado al código */
const DETRACCION = {
  '037': { d: 'Demás servicios gravados con el IGV', p: 12, g: 'servicios' },
  '022': { d: 'Otros servicios empresariales', p: 12, g: 'servicios' },
  '012': { d: 'Intermediación laboral y tercerización', p: 12, g: 'servicios' },
  '020': { d: 'Mantenimiento y reparación de bienes muebles', p: 12, g: 'servicios' },
  '019': { d: 'Arrendamiento de bienes', p: 10, g: 'servicios' },
  '021': { d: 'Movimiento de carga', p: 10, g: 'servicios' },
  '024': { d: 'Comisión mercantil', p: 10, g: 'servicios' },
  '025': { d: 'Fabricación de bienes por encargo', p: 10, g: 'servicios' },
  '026': { d: 'Servicio de transporte de personas', p: 10, g: 'servicios' },
  '030': { d: 'Contratos de construcción', p: 4, g: 'servicios' },
  '004': { d: 'Recursos hidrobiológicos', p: 4, g: 'bienes' },
  '005': { d: 'Maíz amarillo duro', p: 4, g: 'bienes' },
  '007': { d: 'Caña de azúcar', p: 10, g: 'bienes' },
  '008': { d: 'Madera', p: 4, g: 'bienes' },
  '009': { d: 'Arena y piedra', p: 10, g: 'bienes' },
  '010': { d: 'Residuos, subproductos, desechos, recortes y desperdicios', p: 15, g: 'bienes' },
  '014': { d: 'Carnes y despojos comestibles', p: 4, g: 'bienes' },
  '016': { d: 'Aceite de pescado', p: 10, g: 'bienes' },
  '017': { d: 'Harina, polvo y pellets de pescado y crustáceos', p: 4, g: 'bienes' },
  '023': { d: 'Leche', p: 4, g: 'bienes' },
  '031': { d: 'Oro gravado con el IGV', p: 10, g: 'bienes' },
  '032': { d: 'Páprika y otros frutos del género capsicum', p: 10, g: 'bienes' },
  '034': { d: 'Minerales metálicos no auríferos', p: 10, g: 'bienes' },
  '035': { d: 'Bienes exonerados del IGV', p: 1.5, g: 'bienes' },
  '036': { d: 'Oro y demás minerales metálicos exonerados del IGV', p: 1.5, g: 'bienes' },
  '039': { d: 'Minerales no metálicos', p: 10, g: 'bienes' },
  '041': { d: 'Plomo', p: 15, g: 'bienes' },
  '040': { d: 'Bien inmueble gravado con IGV', p: 4, g: 'bienes' },
};
const SPOT_UMBRAL = 700;   // anexos 2 y 3: operaciones mayores a S/ 700 (importe total con IGV)
const esServicio = it => UNIDADES_SERV.includes(it?.unidad);
/* Sugiere bienes/servicios a partir de los ítems: cualquier bien físico ⇒ bienes (hay traslado) */
const sugerirOperacion = items => (!(items || []).length ? '' : items.some(it => !esServicio(it)) ? 'bienes' : 'servicios');
const IGV_OPTS = [{ v: 0.18, l: '18% · Tasa general (IGV 15.5% + IPM 2.5%)' }, { v: 0.105, l: '10.5% · MYPE restaurantes y hoteles (2026)' }];

const SUNAT_EP = [
  ['Emisión (beta)', 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService', 'SOAP · sendBill con ZIP del XML firmado'],
  ['Emisión (producción)', 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService', 'SOAP · facturas, boletas, notas, resúmenes y bajas'],
  ['Consulta de CDR', 'https://e-factura.sunat.gob.pe/ol-it-wsconscpegem/billConsultService', 'SOAP · recuperar la constancia de un comprobante'],
  ['Token API (validez)', 'https://api-seguridad.sunat.gob.pe/v1/clientesextranet/{client_id}/oauth2/token/', 'OAuth2 client credentials (Credenciales de API SUNAT)'],
  ['Validez de comprobantes', 'https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/{ruc}/validarcomprobante', 'REST · estado aceptado / anulado / no informado'],
  ['Token GRE', 'https://api-seguridad.sunat.gob.pe/v1/clientessol/{client_id}/oauth2/token/', 'OAuth2 password: credenciales API SUNAT + usuario SOL'],
  ['Envío de guías (GRE)', 'https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/{ruc}-09-{serie}-{numero}', 'REST · ZIP en base64 + hash SHA-256 → ticket'],
  ['Estado de la guía', 'https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes/envios/{ticket}', 'REST · 0 aceptado · 98 en proceso · 99 con errores (sin ambiente beta)'],
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

/* ---------- SPOT (detracciones) ----------
   El depósito lo hace el cliente en tu cuenta del Banco de la Nación, en soles y redondeado a enteros.
   El neto pendiente de pago (lo que te paga a ti) = total − detracción en la moneda del comprobante. */
function spot(doc, tcDefault) {
  const c = calc(doc), dt = doc.detraccion || {}, cat = DETRACCION[dt.codigo];
  const tc = doc.moneda === 'USD' ? Number(doc.tipoCambio || tcDefault) || 0 : 1;
  const totalPEN = r2(c.total * (tc || 1));
  const sobre = totalPEN > SPOT_UMBRAL;
  const aplica = doc.tipo === '01' && !!cat && !dt.noSujeta && sobre && tc > 0;
  const monto = aplica ? Math.round((totalPEN * cat.p) / 100) : 0;
  const montoDoc = aplica ? (doc.moneda === 'USD' ? r2(monto / tc) : monto) : 0;
  return { aplica, sobre, codigo: dt.codigo || '', desc: cat ? cat.d : '', porcentaje: cat ? cat.p : 0, monto, montoDoc, neto: r2(c.total - montoDoc), total: c.total, totalPEN, tc };
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
const docNum = d => (d.numero ? `${d.serie}-${pad(d.numero, d.tipo === 'COT' || d.tipo === 'NV' ? 6 : 8)}` : `${d.serie}-borrador`);
const docIdSunat = d => `${d.serie}-${d.numero}`;
const fileBase = (d, ruc) => `${ruc}-${d.tipo}-${d.serie}-${d.numero}`;

/* ---------- configuración por defecto ---------- */
function defaultConfig() {
  return {
    empresa: { ruc: '', razon: '', comercial: '', direccion: '', ubigeo: '', distrito: '', provincia: '', departamento: '', telefono: '', email: '', cuentas: '' },
    series: { '01': 'F001', '03': 'B001', '07F': 'FC01', '07B': 'BC01', '08F': 'FD01', '08B': 'BD01', '09': 'T001', NV: 'NV01', COT: 'C001' },
    igvRate: 0.18, incluyeIGV: false, tipoCambio: 3.5, validezDias: 15,
    condiciones: 'Precios en la moneda indicada. Tiempo de entrega a coordinar desde la orden de compra.',
    integracion: { modo: 'simulador', url: '', ambiente: 'beta' },
    /* reglas de emisión: la factura de bienes SIEMPRE exige guía; en boletas es opcional */
    reglas: { guiaBoleta: false, archivarPDF: true },
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
  return { ...d, ...o, empresa: { ...d.empresa, ...(o.empresa || {}) }, series: { ...d.series, ...(o.series || {}) }, integracion: { ...d.integracion, ...(o.integracion || {}) }, reglas: { ...d.reglas, ...(o.reglas || {}) }, docs: mergeDocs(o.docs) };
}
const empresaLista = cfg => validRUC(cfg.empresa.ruc) && cfg.empresa.razon.trim().length > 2 && cfg.empresa.direccion.trim().length > 3;

/* ---------- reglas de emisión (las mismas que valida SUNAT en lo esencial) ---------- */
const GUIA_RE = /^[A-Z0-9]{4}-\d{1,8}$/;
const guiaId = g => `${g.serie}-${Number(g.numero)}`;
function validarDoc(doc, cfg, toPEN) {
  if (doc.tipo === '09') return validarGRE(doc, cfg);
  const e = [];
  const isCPE = ES_CPE(doc.tipo), isNV = doc.tipo === 'NV';
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
  if ((isCPE || isNV) && c.total <= 0) e.push('El importe total debe ser mayor a cero.');
  if (doc.tipo === '03' && (cli.tipoDoc === '0' || !cli.tipoDoc) && toPEN(c.total, doc.moneda) > 700) e.push('Las boletas mayores a S/ 700 deben identificar al cliente con DNI, RUC o C.E.');

  /* bienes o servicios: define si se exige guía (bienes) o se evalúa el SPOT (servicios) */
  if (['01', '03'].includes(doc.tipo)) {
    if (!['bienes', 'servicios'].includes(doc.operacion)) e.push('Elige si estás facturando bienes o servicios.');
    const guias = doc.guias || [];
    const exigeGuia = doc.operacion === 'bienes' && (doc.tipo === '01' || cfg.reglas?.guiaBoleta);
    if (exigeGuia && !guias.length) e.push(`Venta de bienes: vincula la guía de remisión remitente (es obligatoria${doc.tipo === '03' ? ' según tus reglas' : ''}).`);
    guias.forEach(g => { if (!GUIA_RE.test(guiaId(g))) e.push(`La guía ${g.serie}-${g.numero} no tiene un número válido (serie de 4 caracteres y correlativo).`); });
  }
  const sp = spot(doc, cfg.tipoCambio);
  if (doc.tipo === '01') {
    const dt = doc.detraccion || {};
    if (doc.moneda === 'USD' && dt.codigo && !(Number(doc.tipoCambio) > 0)) e.push('Indica el tipo de cambio del día para calcular la detracción en soles.');
    if (doc.operacion === 'servicios' && sp.sobre && !dt.codigo && !dt.noSujeta) e.push(`La factura de servicios supera ${money(SPOT_UMBRAL)}: elige el tipo de detracción (catálogo 54) o márcala como no sujeta indicando el motivo.`);
    if (dt.noSujeta && !String(dt.motivo || '').trim()) e.push('Indica por qué la operación no está sujeta a detracción.');
    if (sp.aplica && !String(cfg.docs?.detraccion || '').trim()) e.push('Registra tu cuenta de detracciones del Banco de la Nación en «Personalizar documentos».');
  }
  if (doc.tipo === '01' && doc.formaPago === 'Credito') {
    const cuotas = doc.cuotas || [];
    const objetivo = sp.aplica ? sp.neto : c.total;
    if (!cuotas.length) e.push('Una factura al crédito necesita al menos una cuota.');
    const sum = r2(cuotas.reduce((a, q) => a + (Number(q.monto) || 0), 0));
    if (cuotas.length && Math.abs(sum - objetivo) > 0.01) e.push(`Las cuotas suman ${money(sum, doc.moneda)} y deben sumar ${sp.aplica ? 'el neto pendiente (total menos detracción)' : 'el total'}: ${money(objetivo, doc.moneda)}.`);
    cuotas.forEach((q, i) => { if (!q.fecha || q.fecha <= doc.fecha) e.push(`La cuota ${i + 1} debe vencer después de la fecha de emisión.`); });
  }
  if (ES_NOTA(doc.tipo)) {
    const nom = doc.tipo === '07' ? 'nota de crédito' : 'nota de débito';
    if (!doc.ref || !doc.ref.serie) e.push(`La ${nom} debe referenciar el comprobante que modifica.`);
    if (!doc.ref?.motivo || !(doc.tipo === '07' ? MOTIVOS_NC : MOTIVOS_ND)[doc.ref.motivo]) e.push(`Elige el motivo de la ${nom}.`);
    if (!String(doc.ref?.sustento || '').trim()) e.push(`Escribe el sustento de la ${nom}.`);
    if (doc.ref?.tipo && doc.serie && doc.serie[0] !== (doc.ref.tipo === '01' ? 'F' : 'B')) e.push(`La serie de la ${nom} debe empezar con ${doc.ref.tipo === '01' ? 'F' : 'B'}, como el comprobante que modifica.`);
  }
  if ((isCPE || isNV) && doc.fecha > todayISO()) e.push('La fecha de emisión no puede ser futura.');
  return e;
}

/* ---------- guía de remisión remitente (09) ---------- */
const UBIGEO_RE = /^\d{6}$/;
const PLACA_RE = /^[A-Z0-9]{6,8}$/;
const LICENCIA_RE = /^[A-Z]\d{8}$/;
const normPlaca = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function validarGRE(doc, cfg) {
  const e = [], t = doc.traslado || {}, cli = doc.cliente || {};
  if (!empresaLista(cfg)) e.push('Completa RUC, razón social y dirección fiscal de tu empresa en «Integración SUNAT».');
  if (!cli.nombre || cli.nombre.trim().length < 2) e.push('Indica el destinatario de los bienes.');
  if (!cli.tipoDoc || cli.tipoDoc === '0' || !validDocId(cli.tipoDoc, cli.numDoc)) e.push('El destinatario debe identificarse con RUC, DNI o C.E. válido.');
  if (!MOTIVOS_TRASLADO[t.motivo]) e.push('Elige el motivo de traslado.');
  if (t.motivo === '13' && !String(t.descMotivo || '').trim()) e.push('Describe el motivo de traslado «Otros».');
  if (['04'].includes(t.motivo) && cli.numDoc && cli.numDoc !== cfg.empresa.ruc) e.push('En traslados entre establecimientos el destinatario es tu propia empresa.');
  if (!t.fechaInicio) e.push('Indica la fecha de inicio del traslado.');
  else if (t.fechaInicio < doc.fecha) e.push('El traslado no puede iniciar antes de la fecha de emisión de la guía.');
  if (!(Number(t.pesoKg) > 0)) e.push('Indica el peso bruto total de la carga en kilogramos.');
  const P = t.partida || {}, L = t.llegada || {};
  if (!UBIGEO_RE.test(P.ubigeo || '') || !String(P.direccion || '').trim()) e.push('Completa el punto de partida: ubigeo de 6 dígitos y dirección.');
  if (!UBIGEO_RE.test(L.ubigeo || '') || !String(L.direccion || '').trim()) e.push('Completa el punto de llegada: ubigeo de 6 dígitos y dirección.');
  if (P.ubigeo && P.ubigeo === L.ubigeo && String(P.direccion).trim().toLowerCase() === String(L.direccion).trim().toLowerCase()) e.push('El punto de partida y el de llegada no pueden ser la misma dirección.');
  if (t.modalidad === '01') {
    const tr = t.transportista || {};
    if (!validRUC(tr.ruc)) e.push('Transporte público: indica el RUC válido de la empresa de transportes.');
    if (!String(tr.razon || '').trim()) e.push('Transporte público: indica la razón social del transportista.');
    if (tr.ruc && tr.ruc === cfg.empresa.ruc) e.push('En transporte público el transportista no puede ser tu propia empresa: usa transporte privado.');
  } else if (t.modalidad === '02') {
    if (!t.m1l) {
      const ch = t.conductor || {};
      if (!/^\d{8}$/.test(ch.numDoc || '')) e.push('Transporte privado: indica el DNI del conductor (8 dígitos).');
      if (!String(ch.nombres || '').trim() || !String(ch.apellidos || '').trim()) e.push('Transporte privado: indica nombres y apellidos del conductor.');
      if (!LICENCIA_RE.test(String(ch.licencia || '').toUpperCase())) e.push('La licencia de conducir tiene el formato letra + 8 dígitos (p. ej. Q12345678).');
      if (!PLACA_RE.test(normPlaca(t.placa))) e.push('Indica la placa del vehículo (6 a 8 letras y números, sin guion).');
    }
  } else e.push('Elige la modalidad de traslado: privado o público.');
  if (!(doc.items || []).length) e.push('Agrega los bienes que se trasladan.');
  (doc.items || []).forEach((it, i) => {
    if (!String(it.desc || '').trim()) e.push(`El bien ${i + 1} no tiene descripción.`);
    if (!(Number(it.cant) > 0)) e.push(`La cantidad del bien ${i + 1} debe ser mayor a cero.`);
    if (esServicio(it)) e.push(`La línea ${i + 1} es un servicio (${UNIDADES[it.unidad]}): en una guía solo van bienes que se trasladan.`);
  });
  if (doc.fecha > todayISO()) e.push('La fecha de emisión no puede ser futura.');
  return e;
}

/* ---------- XML UBL 2.1 (estructura SUNAT, sin firma) ---------- */
function buildXML(doc, cfg) {
  if (doc.tipo === '09') return buildGRE(doc, cfg);
  const c = calc(doc), e = cfg.empresa, cli = doc.cliente || {};
  const cur = doc.moneda || 'PEN', A = `currencyID="${cur}"`;
  const isNC = doc.tipo === '07', isND = doc.tipo === '08', isNota = isNC || isND;
  const root = isNC ? 'CreditNote' : isND ? 'DebitNote' : 'Invoice';
  const sp = spot(doc, cfg.tipoCambio);
  const X = s => esc(s);
  const cd = s => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  const id = docIdSunat(doc);
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push(`<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">`);
  L.push('  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><!-- Aquí va la firma XMLDSig (certificado digital) que agrega tu backend --></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>');
  L.push('  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>', '  <cbc:CustomizationID>2.0</cbc:CustomizationID>');
  L.push(`  <cbc:ID>${X(id)}</cbc:ID>`, `  <cbc:IssueDate>${doc.fecha}</cbc:IssueDate>`, `  <cbc:IssueTime>${doc.hora || '00:00:00'}</cbc:IssueTime>`);
  if (!isNota) {
    if (doc.vence) L.push(`  <cbc:DueDate>${doc.vence}</cbc:DueDate>`);
    // catálogo 51: 0101 venta interna · 1001 operación sujeta a detracción
    L.push(`  <cbc:InvoiceTypeCode listID="${sp.aplica ? '1001' : '0101'}">${doc.tipo}</cbc:InvoiceTypeCode>`);
  }
  L.push(`  <cbc:Note languageLocaleID="1000">${cd(numeroALetras(c.total, cur))}</cbc:Note>`);
  if (sp.aplica) L.push(`  <cbc:Note languageLocaleID="2006">${cd('Operación sujeta a detracción')}</cbc:Note>`);
  L.push(`  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`);
  if (isNota && doc.ref) {
    const refId = `${doc.ref.serie}-${Number(doc.ref.numero)}`;
    L.push('  <cac:DiscrepancyResponse>', `    <cbc:ReferenceID>${X(refId)}</cbc:ReferenceID>`, `    <cbc:ResponseCode>${X(doc.ref.motivo)}</cbc:ResponseCode>`, `    <cbc:Description>${cd(doc.ref.sustento)}</cbc:Description>`, '  </cac:DiscrepancyResponse>');
    L.push('  <cac:BillingReference><cac:InvoiceDocumentReference>', `    <cbc:ID>${X(refId)}</cbc:ID>`, `    <cbc:DocumentTypeCode>${X(doc.ref.tipo)}</cbc:DocumentTypeCode>`, '  </cac:InvoiceDocumentReference></cac:BillingReference>');
  }
  // guías de remisión que sustentan el traslado de los bienes facturados
  if (!isNota) (doc.guias || []).forEach(g => L.push(`  <cac:DespatchDocumentReference><cbc:ID>${X(guiaId(g))}</cbc:ID><cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">09</cbc:DocumentTypeCode></cac:DespatchDocumentReference>`));
  L.push('  <cac:Signature>', `    <cbc:ID>${X(e.ruc)}</cbc:ID>`, `    <cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${X(e.ruc)}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${cd(e.razon)}</cbc:Name></cac:PartyName></cac:SignatoryParty>`, '    <cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SignatureSP</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>', '  </cac:Signature>');
  L.push('  <cac:AccountingSupplierParty><cac:Party>', `    <cac:PartyIdentification><cbc:ID schemeID="6">${X(e.ruc)}</cbc:ID></cac:PartyIdentification>`, `    <cac:PartyName><cbc:Name>${cd(e.comercial || e.razon)}</cbc:Name></cac:PartyName>`, `    <cac:PartyLegalEntity><cbc:RegistrationName>${cd(e.razon)}</cbc:RegistrationName>`, `      <cac:RegistrationAddress><cbc:ID>${X(e.ubigeo)}</cbc:ID><cbc:AddressTypeCode>0000</cbc:AddressTypeCode><cbc:CityName>${cd(e.provincia)}</cbc:CityName><cbc:CountrySubentity>${cd(e.departamento)}</cbc:CountrySubentity><cbc:District>${cd(e.distrito)}</cbc:District><cac:AddressLine><cbc:Line>${cd(e.direccion)}</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>`, '    </cac:PartyLegalEntity>', '  </cac:Party></cac:AccountingSupplierParty>');
  L.push('  <cac:AccountingCustomerParty><cac:Party>', `    <cac:PartyIdentification><cbc:ID schemeID="${X(cli.tipoDoc || '0')}">${X(cli.tipoDoc === '0' ? '-' : cli.numDoc)}</cbc:ID></cac:PartyIdentification>`, `    <cac:PartyLegalEntity><cbc:RegistrationName>${cd(cli.nombre)}</cbc:RegistrationName>${cli.direccion ? `<cac:RegistrationAddress><cac:AddressLine><cbc:Line>${cd(cli.direccion)}</cbc:Line></cac:AddressLine></cac:RegistrationAddress>` : ''}</cac:PartyLegalEntity>`, '  </cac:Party></cac:AccountingCustomerParty>');
  if (sp.aplica) {
    // SPOT: cuenta del Banco de la Nación + código (cat. 54), porcentaje y monto en soles
    L.push(`  <cac:PaymentMeans><cbc:ID>Detraccion</cbc:ID><cbc:PaymentMeansCode>001</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>${X(cfg.docs.detraccion)}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>`);
    L.push(`  <cac:PaymentTerms><cbc:ID>Detraccion</cbc:ID><cbc:PaymentMeansID>${X(sp.codigo)}</cbc:PaymentMeansID><cbc:PaymentPercent>${sp.porcentaje}</cbc:PaymentPercent><cbc:Amount currencyID="PEN">${sp.monto.toFixed(2)}</cbc:Amount></cac:PaymentTerms>`);
  }
  if (doc.tipo === '01') {
    if (doc.formaPago === 'Credito') {
      // con detracción, el crédito informa el neto pendiente de pago (total − detracción)
      L.push(`  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Credito</cbc:PaymentMeansID><cbc:Amount ${A}>${(sp.aplica ? sp.neto : c.total).toFixed(2)}</cbc:Amount></cac:PaymentTerms>`);
      (doc.cuotas || []).forEach((q, i) => L.push(`  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Cuota${pad(i + 1, 3)}</cbc:PaymentMeansID><cbc:Amount ${A}>${Number(q.monto).toFixed(2)}</cbc:Amount><cbc:PaymentDueDate>${q.fecha}</cbc:PaymentDueDate></cac:PaymentTerms>`));
    } else L.push('  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms>');
  }
  const sub = (base, tax, code, name, type) => `    <cac:TaxSubtotal><cbc:TaxableAmount ${A}>${base.toFixed(2)}</cbc:TaxableAmount><cbc:TaxAmount ${A}>${tax.toFixed(2)}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>${code}</cbc:ID><cbc:Name>${name}</cbc:Name><cbc:TaxTypeCode>${type}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`;
  L.push('  <cac:TaxTotal>', `    <cbc:TaxAmount ${A}>${c.igv.toFixed(2)}</cbc:TaxAmount>`);
  if (c.gravada || (!c.exonerada && !c.inafecta)) L.push(sub(c.gravada, c.igv, '1000', 'IGV', 'VAT'));
  if (c.exonerada) L.push(sub(c.exonerada, 0, '9997', 'EXO', 'VAT'));
  if (c.inafecta) L.push(sub(c.inafecta, 0, '9998', 'INA', 'FRE'));
  L.push('  </cac:TaxTotal>');
  const mt = isND ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal';
  L.push(`  <cac:${mt}>`, `    <cbc:LineExtensionAmount ${A}>${r2(c.gravada + c.exonerada + c.inafecta).toFixed(2)}</cbc:LineExtensionAmount>`, `    <cbc:TaxInclusiveAmount ${A}>${c.total.toFixed(2)}</cbc:TaxInclusiveAmount>`, `    <cbc:PayableAmount ${A}>${c.total.toFixed(2)}</cbc:PayableAmount>`, `  </cac:${mt}>`);
  const lineTag = isNC ? 'CreditNoteLine' : isND ? 'DebitNoteLine' : 'InvoiceLine', qtyTag = isNC ? 'CreditedQuantity' : isND ? 'DebitedQuantity' : 'InvoicedQuantity';
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

/* GRE remitente (09) · UBL 2.1 DespatchAdvice, formato SUNAT 2022 (se envía por la API REST de GRE) */
function buildGRE(doc, cfg) {
  const e = cfg.empresa, cli = doc.cliente || {}, t = doc.traslado || {};
  const X = s => esc(s);
  const cd = s => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  const C = n => `listAgencyName="PE:SUNAT" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo${n}"`;
  const ID6 = 'schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06"';
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">');
  L.push('  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent><!-- Aquí va la firma XMLDSig (certificado digital) que agrega tu backend --></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>');
  L.push('  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>', '  <cbc:CustomizationID>2.0</cbc:CustomizationID>');
  L.push(`  <cbc:ID>${X(docIdSunat(doc))}</cbc:ID>`, `  <cbc:IssueDate>${doc.fecha}</cbc:IssueDate>`, `  <cbc:IssueTime>${doc.hora || '00:00:00'}</cbc:IssueTime>`);
  L.push(`  <cbc:DespatchAdviceTypeCode ${C('01')} listName="Tipo de Documento">09</cbc:DespatchAdviceTypeCode>`);
  if (doc.obs) L.push(`  <cbc:Note>${cd(doc.obs)}</cbc:Note>`);
  if (doc.docRel && doc.docRel.serie) {
    const r = doc.docRel;
    L.push('  <cac:AdditionalDocumentReference>', `    <cbc:ID>${X(`${r.serie}-${Number(r.numero)}`)}</cbc:ID>`, `    <cbc:DocumentTypeCode ${C('61')} listName="Documento relacionado al transporte">${X(r.tipo)}</cbc:DocumentTypeCode>`, `    <cbc:DocumentType>${X(DOC_REL_GRE[r.tipo] || '')}</cbc:DocumentType>`, `    <cac:IssuerParty><cac:PartyIdentification><cbc:ID schemeID="6" ${ID6}>${X(e.ruc)}</cbc:ID></cac:PartyIdentification></cac:IssuerParty>`, '  </cac:AdditionalDocumentReference>');
  }
  L.push('  <cac:Signature>', `    <cbc:ID>${X(e.ruc)}</cbc:ID>`, `    <cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${X(e.ruc)}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${cd(e.razon)}</cbc:Name></cac:PartyName></cac:SignatoryParty>`, '    <cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SignatureSP</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment>', '  </cac:Signature>');
  L.push(`  <cac:DespatchSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6" ${ID6}>${X(e.ruc)}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${cd(e.razon)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:DespatchSupplierParty>`);
  L.push(`  <cac:DeliveryCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${X(cli.tipoDoc)}" ${ID6}>${X(cli.numDoc)}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${cd(cli.nombre)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:DeliveryCustomerParty>`);
  L.push('  <cac:Shipment>', '    <cbc:ID>SUNAT_Envio</cbc:ID>');
  L.push(`    <cbc:HandlingCode ${C('20')} listName="Motivo de traslado">${X(t.motivo)}</cbc:HandlingCode>`);
  L.push(`    <cbc:HandlingInstructions>${cd(t.motivo === '13' ? t.descMotivo : MOTIVOS_TRASLADO[t.motivo])}</cbc:HandlingInstructions>`);
  L.push(`    <cbc:GrossWeightMeasure unitCode="KGM">${Number(t.pesoKg || 0).toFixed(3)}</cbc:GrossWeightMeasure>`);
  if (Number(t.bultos) > 0) L.push(`    <cbc:TotalTransportHandlingUnitQuantity>${Math.round(Number(t.bultos))}</cbc:TotalTransportHandlingUnitQuantity>`);
  if (t.modalidad === '02' && t.m1l) L.push('    <cbc:SpecialInstructions>SUNAT_Envio_IndicadorTrasladoVehiculoM1L</cbc:SpecialInstructions>');
  L.push('    <cac:ShipmentStage>', `      <cbc:TransportModeCode listName="Modalidad de traslado" ${C('18')}>${X(t.modalidad)}</cbc:TransportModeCode>`, `      <cac:TransitPeriod><cbc:StartDate>${X(t.fechaInicio)}</cbc:StartDate></cac:TransitPeriod>`);
  if (t.modalidad === '01') {
    const tr = t.transportista || {};
    L.push(`      <cac:CarrierParty><cac:PartyIdentification><cbc:ID schemeID="6">${X(tr.ruc)}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${cd(tr.razon)}</cbc:RegistrationName>${tr.mtc ? `<cbc:CompanyID>${X(tr.mtc)}</cbc:CompanyID>` : ''}</cac:PartyLegalEntity></cac:CarrierParty>`);
  } else if (!t.m1l) {
    const ch = t.conductor || {};
    L.push(`      <cac:DriverPerson><cbc:ID schemeID="1" ${ID6}>${X(ch.numDoc)}</cbc:ID><cbc:FirstName>${cd(ch.nombres)}</cbc:FirstName><cbc:FamilyName>${cd(ch.apellidos)}</cbc:FamilyName><cbc:JobTitle>Principal</cbc:JobTitle><cac:IdentityDocumentReference><cbc:ID>${X(String(ch.licencia || '').toUpperCase())}</cbc:ID></cac:IdentityDocumentReference></cac:DriverPerson>`);
  }
  L.push('    </cac:ShipmentStage>');
  const P = t.partida || {}, Ll = t.llegada || {};
  L.push('    <cac:Delivery>', `      <cac:DeliveryAddress><cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${X(Ll.ubigeo)}</cbc:ID><cac:AddressLine><cbc:Line>${cd(Ll.direccion)}</cbc:Line></cac:AddressLine></cac:DeliveryAddress>`, `      <cac:Despatch><cac:DespatchAddress><cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${X(P.ubigeo)}</cbc:ID><cac:AddressLine><cbc:Line>${cd(P.direccion)}</cbc:Line></cac:AddressLine></cac:DespatchAddress></cac:Despatch>`, '    </cac:Delivery>');
  if (t.modalidad === '02' && !t.m1l && t.placa) L.push(`    <cac:TransportHandlingUnit><cac:TransportEquipment><cbc:ID>${X(normPlaca(t.placa))}</cbc:ID></cac:TransportEquipment></cac:TransportHandlingUnit>`);
  L.push('  </cac:Shipment>');
  (doc.items || []).forEach((it, i) => {
    L.push('  <cac:DespatchLine>', `    <cbc:ID>${i + 1}</cbc:ID>`, `    <cbc:DeliveredQuantity unitCode="${X(it.unidad || 'NIU')}">${decStr(Number(it.cant) || 0, 0, 10).replace(/\.$/, '')}</cbc:DeliveredQuantity>`, `    <cac:OrderLineReference><cbc:LineID>${i + 1}</cbc:LineID></cac:OrderLineReference>`, `    <cac:Item><cbc:Description>${cd(it.desc)}</cbc:Description><cac:SellersItemIdentification><cbc:ID>${X(it.codigo || `ITEM${i + 1}`)}</cbc:ID></cac:SellersItemIdentification></cac:Item>`, '  </cac:DespatchLine>');
  });
  L.push('</DespatchAdvice>');
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
    { tipoDoc: '6', numDoc: '20000000028', nombre: 'Constructora Demo Norte S.A.C.', direccion: 'Av. Demo 456, Trujillo, La Libertad', ubigeo: '130101', email: 'compras@constructora-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '20000000036', nombre: 'Agroexportadora Demo Sur S.A.', direccion: 'Panamericana Sur km 300, Ica', ubigeo: '110101', email: 'logistica@agro-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '20000000044', nombre: 'Distribuidora Demo Centro S.R.L.', direccion: 'Jr. Ejemplo 789, Huancayo, Junín', ubigeo: '120101', email: 'pagos@distribuidora-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '20000000052', nombre: 'Inversiones Demo Lima E.I.R.L.', direccion: 'Calle Muestra 321, Miraflores, Lima', ubigeo: '150122', email: 'gerencia@inversiones-demo.pe', telefono: '' },
    { tipoDoc: '6', numDoc: '10000000014', nombre: 'Ana Pérez Rojas (demo)', direccion: 'Av. Prueba 100, Surco, Lima', ubigeo: '150140', email: '', telefono: '' },
    { tipoDoc: '1', numDoc: '00000001', nombre: 'Carlos Mendoza (demo)', direccion: 'Jr. Prueba 55, Lince, Lima', ubigeo: '150116', email: '', telefono: '' },
  ].map(c => ({ ...c, id: uid(), demo: true }));
  const P = [
    { codigo: 'P001', desc: 'Consultoría especializada (hora)', unidad: 'HUR', precio: 180, afect: '10', detraccion: '022' },
    { codigo: 'P002', desc: 'Implementación de dashboard BI', unidad: 'ZZ', precio: 4800, afect: '10', detraccion: '037' },
    { codigo: 'P003', desc: 'Licencia plataforma analítica (usuario/mes)', unidad: 'ZZ', precio: 95, afect: '10', detraccion: '037' },
    { codigo: 'P004', desc: 'Taller de capacitación in-house (8 h)', unidad: 'ZZ', precio: 2200, afect: '10', detraccion: '037' },
    { codigo: 'P005', desc: 'Laptop 14" Core i7 · 16 GB · 512 GB SSD', unidad: 'NIU', precio: 3650, afect: '10', pesoKg: 2.1 },
    { codigo: 'P006', desc: 'Monitor 27" QHD', unidad: 'NIU', precio: 980, afect: '10', pesoKg: 6.5 },
    { codigo: 'P007', desc: 'Soporte y mantenimiento mensual', unidad: 'ZZ', precio: 1150, afect: '10', detraccion: '037' },
  ].map(p => ({ ...p, id: uid(), demo: true }));
  const docs = [];
  const cliSnap = i => { const c = C[i]; return { id: c.id, tipoDoc: c.tipoDoc, numDoc: c.numDoc, nombre: c.nombre, direccion: c.direccion, ubigeo: c.ubigeo, email: c.email, telefono: c.telefono }; };
  const items = arr => arr.map(([pi, q]) => ({ id: uid(), codigo: P[pi].codigo, desc: P[pi].desc, unidad: P[pi].unidad, cant: q, precio: P[pi].precio, afect: '10' }));
  const okSunat = (tipo, serie, numero, fecha) => ({ estado: 'aceptado', codigo: '0', descripcion: `La ${TIPOS[tipo].sunat} numero ${serie}-${numero}, ha sido aceptada`, hash: (uid() + uid()).slice(0, 28), fecha: fecha + 'T10:31:00', modo: 'simulador', ambiente: 'beta' });
  const mk = (tipo, numero, ago, ci, its, extra = {}) => {
    const fecha = addDays(today, -ago);
    const serie = tipo === 'COT' ? cfg.series.COT : tipo === '07' ? cfg.series['07F'] : tipo === '08' ? cfg.series['08F'] : cfg.series[tipo];
    const d = { id: uid(), tipo, serie, numero, fecha, hora: '10:30:00', moneda: 'PEN', incluyeIGV: false, igvRate: 0.18, cliente: cliSnap(ci), items: items(its), formaPago: 'Contado', cuotas: [], obs: '', estado: tipo === 'COT' ? 'enviada' : tipo === 'NV' ? 'emitida' : 'aceptado', creado: fecha + 'T10:30:00', demo: true, ...extra };
    if (tipo === 'COT') { d.vence = d.vence || addDays(fecha, 15); d.condiciones = cfg.condiciones; }
    if (['01', '03'].includes(tipo)) { d.operacion = d.operacion || sugerirOperacion(d.items); d.guias = d.guias || []; }
    if (tipo === '01' && d.operacion === 'servicios') {
      const cods = d.items.map(it => P.find(p => p.codigo === it.codigo)?.detraccion).filter(Boolean);
      if (spot({ ...d, detraccion: { codigo: cods[0] || '037' } }, cfg.tipoCambio).sobre) d.detraccion = { codigo: cods[0] || '037' };
    }
    d.totales = (({ gravada, exonerada, inafecta, igv, total }) => ({ gravada, exonerada, inafecta, igv, total }))(calc(d));
    if (ES_SUNAT(tipo) && d.estado === 'aceptado') d.sunat = okSunat(tipo, d.serie, numero, fecha);
    docs.push(d); return d;
  };
  /* guía de remisión de los bienes de una factura (se emite antes de facturar, como en un despacho real) */
  let nGre = 0;
  const gre = (fac, ago, extra = {}) => {
    const fecha = addDays(today, -ago), ci = C.findIndex(c => c.id === fac.cliente.id);
    const its = fac.items.filter(it => !esServicio(it)).map(it => ({ id: uid(), codigo: it.codigo, desc: it.desc, unidad: it.unidad, cant: it.cant }));
    const peso = r2(its.reduce((a, it) => a + (P.find(p => p.codigo === it.codigo)?.pesoKg || 1) * it.cant, 0) + 1.5);
    const d = { id: uid(), tipo: '09', serie: cfg.series['09'], numero: ++nGre, fecha, hora: '09:10:00', cliente: cliSnap(ci), items: its, obs: '', estado: 'aceptado', creado: fecha + 'T09:10:00', demo: true,
      traslado: { motivo: '01', descMotivo: '', fechaInicio: fecha, modalidad: '02', pesoKg: peso, bultos: its.reduce((a, it) => a + it.cant, 0), m1l: false,
        partida: { ubigeo: cfg.empresa.ubigeo, direccion: cfg.empresa.direccion }, llegada: { ubigeo: C[ci].ubigeo, direccion: C[ci].direccion },
        conductor: { tipoDoc: '1', numDoc: '00000002', nombres: 'Luis Alberto', apellidos: 'Quispe Ramos', licencia: 'Q00000002' }, placa: 'ABC123', transportista: { ruc: '', razon: '', mtc: '' } },
      docRel: null, ...extra };
    d.sunat = { ...okSunat('09', d.serie, d.numero, fecha), descripcion: `La Guia de Remision ${d.serie}-${d.numero} ha sido aceptada (simulador: SUNAT no tiene beta de GRE)` };
    fac.guias = [{ id: d.id, serie: d.serie, numero: d.numero }];
    docs.push(d); return d;
  };
  const link = (cot, f) => { cot.estado = 'facturada'; cot.facturaId = f.id; f.origenId = cot.id; };
  const c1 = mk('COT', 1, 175, 0, [[1, 1], [0, 10]]);
  const f1 = mk('01', 1, 165, 0, [[1, 1], [0, 10]], { cobrado: true }); link(c1, f1);
  const f2 = mk('01', 2, 150, 1, [[4, 3]], { cobrado: true }); gre(f2, 151);
  const c2 = mk('COT', 2, 100, 0, [[6, 1]]);
  mk('01', 3, 128, 3, [[6, 1]], { cobrado: true });
  mk('01', 4, 120, 2, [[3, 1], [2, 10]], { cobrado: true });
  const f5 = mk('01', 5, 95, 0, [[6, 1]], { cobrado: true }); link(c2, f5);
  const c3 = mk('COT', 3, 92, 1, [[1, 1]]);
  const f6 = mk('01', 6, 88, 1, [[1, 1]], { cobrado: true }); link(c3, f6);
  const f7 = mk('01', 7, 70, 3, [[4, 2], [5, 2]], { cobrado: true }); gre(f7, 71);
  const nc = mk('07', 1, 64, 3, [[5, 1]]);
  nc.ref = { id: f7.id, tipo: '01', serie: f7.serie, numero: f7.numero, motivo: '07', sustento: 'Devolución de un monitor por falla de fábrica.' };
  mk('01', 8, 60, 2, [[6, 1]], { cobrado: true });
  const nv1 = mk('NV', 1, 51, 5, [[5, 1]], { serie: cfg.series.NV });
  const b1 = mk('03', 1, 50, 5, [[5, 1]], { serie: 'B001', cliente: cliSnap(5) }); nv1.estado = 'convertida'; nv1.facturaId = b1.id; b1.origenId = nv1.id;
  const f9 = mk('01', 9, 45, 0, [[0, 24]], { formaPago: 'Credito' });
  f9.cuotas = [{ monto: spot(f9, cfg.tipoCambio).neto, fecha: addDays(f9.fecha, 30) }]; f9.vence = f9.cuotas[0].fecha; f9.cobrado = false;
  const c4 = mk('COT', 4, 40, 1, [[1, 1], [3, 1]]);
  const f10 = mk('01', 10, 33, 1, [[1, 1], [3, 1]], { cobrado: true }); link(c4, f10);
  mk('COT', 5, 26, 2, [[1, 1]], { estado: 'rechazada' });
  mk('01', 11, 20, 3, [[2, 25], [6, 1]], { cobrado: true });
  const nd = mk('08', 1, 16, 0, [], { items: [{ id: uid(), codigo: '', desc: 'Intereses moratorios por pago fuera de plazo', unidad: 'ZZ', cant: 1, precio: 120, afect: '10' }] });
  nd.ref = { id: f9.id, tipo: '01', serie: f9.serie, numero: f9.numero, motivo: '01', sustento: 'Intereses por 15 días de atraso en la cuota 1.' };
  nd.totales = (({ gravada, exonerada, inafecta, igv, total }) => ({ gravada, exonerada, inafecta, igv, total }))(calc(nd));
  mk('COT', 6, 14, 3, [[1, 1], [3, 1]], { estado: 'aprobada' });
  mk('COT', 7, 13, 0, [[0, 40]], { estado: 'enviada' });
  mk('COT', 8, 10, 2, [[4, 4], [5, 4]], { estado: 'enviada' });
  const f12 = mk('01', 12, 9, 2, [[4, 1], [5, 1]], { formaPago: 'Credito' }); gre(f12, 9, { docRel: null });
  const half = r2(f12.totales.total / 2);
  f12.cuotas = [{ monto: half, fecha: addDays(f12.fecha, 30) }, { monto: r2(f12.totales.total - half), fecha: addDays(f12.fecha, 60) }]; f12.vence = f12.cuotas[1].fecha; f12.cobrado = false;
  mk('03', 2, 6, 5, [[2, 2]], { serie: 'B001', cliente: { id: '', tipoDoc: '0', numDoc: '', nombre: 'Clientes varios', direccion: '', email: '', telefono: '' } });
  mk('NV', 2, 5, 4, [[3, 1]], { serie: cfg.series.NV });
  mk('01', 13, 4, 0, [[0, 8]], { cobrado: true });
  mk('COT', 9, 3, 1, [[1, 1], [2, 20]], { estado: 'enviada' });
  const fr = mk('01', 14, 2, 4, [[0, 6]], { estado: 'rechazado' });
  fr.sunat = { estado: 'rechazado', codigo: '—', descripcion: 'Rechazo de ejemplo: el receptor no figura activo en el padrón. Corrige y emite un nuevo comprobante.', hash: '', fecha: fr.fecha + 'T11:02:00', modo: 'simulador', ambiente: 'beta' };
  mk('01', 15, 1, 1, [[6, 1]], { estado: 'pendiente' });
  mk('COT', 10, 0, 3, [[2, 15]], { estado: 'borrador' });
  // bitácora inicial: un evento por documento (lo que vería un sistema que lleva meses operando)
  const movimientos = docs.filter(d => d.numero).map(d => ({ id: uid(), ts: new Date(d.sunat?.fecha || d.creado).toISOString(), evento: d.tipo === 'COT' ? 'cotizacion.creada' : d.tipo === 'NV' ? 'nota_venta.emitida' : d.estado === 'rechazado' ? 'sunat.rechazado' : d.estado === 'aceptado' ? 'sunat.aceptado' : 'documento.emitido', docId: d.id, tipo: d.tipo, docNum: docNum(d), cliente: d.cliente?.nombre || '', monto: d.totales?.total || 0, moneda: d.moneda || 'PEN', detalle: d.sunat?.descripcion || '', demo: true }));
  return { cfg, clientes: C, productos: P, documentos: docs, movimientos };
}

if (typeof module !== 'undefined') module.exports = { BLOQUES, TIPOS, DETRACCION, MOTIVOS_ND, MOTIVOS_TRASLADO, defaultDocs, mergeDocs, mergeCfg, calc, spot, numeroALetras, validRUC, buildXML, buildGRE, buildSeed, defaultConfig, validarDoc, validarGRE, sugerirOperacion, docNum, qrText, money };
