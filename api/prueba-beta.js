// Envía al beta oficial de SUNAT: detracción (contado, crédito, USD), factura de bienes con guía, nota de débito y nota de crédito.
// Uso: npm run prueba:beta   (opcional: node prueba-beta.js "detracción")
const core = require('./ubl.js');
const { emitir } = require('./sunat.js');
const forge = require('node-forge');
const k = forge.pki.rsa.generateKeyPair(2048), c = forge.pki.createCertificate(); c.publicKey = k.publicKey; c.serialNumber = '01'; c.validity.notBefore = new Date(); c.validity.notAfter = new Date(Date.now() + 864e5); c.setSubject([{ name: 'commonName', value: 'Granate BETA' }]); c.setIssuer([{ name: 'commonName', value: 'Granate BETA' }]); c.sign(k.privateKey, forge.md.sha256.create());
const keyPem = forge.pki.privateKeyToPem(k.privateKey), certPem = forge.pki.certificateToPem(c);
const seed = core.buildSeed('2026-11-07'), cfg = seed.cfg;
const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const base = Math.floor(Date.now() / 1000) % 9000000;
const cli = { tipoDoc: '6', numDoc: '20000000028', nombre: 'Constructora Demo Norte S.A.C.', direccion: 'Av. Demo 456, Trujillo' };
const serv = [{ codigo: 'P002', desc: 'Implementación de dashboard BI', unidad: 'ZZ', cant: 1, precio: 4800, afect: '10' }, { codigo: 'P001', desc: 'Consultoría especializada (hora)', unidad: 'HUR', cant: 2, precio: 180, afect: '10' }];
const bienes = [{ codigo: 'P005', desc: 'Laptop 14 Core i7', unidad: 'NIU', cant: 2, precio: 3650, afect: '10' }];
const mk = (n, tipo, serie, extra) => Object.assign({ tipo, serie, numero: base + n, fecha: today, hora: '12:00:00', moneda: 'PEN', incluyeIGV: false, igvRate: 0.18, cliente: cli, items: serv, formaPago: 'Contado', cuotas: [] }, extra);
const casos = [];
casos.push(['01 servicios + detracción 037 contado', mk(1, '01', 'F001', { operacion: 'servicios', detraccion: { codigo: '037' } })]);
{ const d = mk(2, '01', 'F001', { operacion: 'servicios', detraccion: { codigo: '022' }, formaPago: 'Credito' }); const sp = core.spot(d, 3.5); const h = Math.round(sp.neto * 50) / 100; d.cuotas = [{ monto: h, fecha: '2026-12-15' }, { monto: Math.round((sp.neto - h) * 100) / 100, fecha: '2027-01-15' }]; d.vence = '2027-01-15'; casos.push(['01 servicios + detracción 022 crédito (cuotas = neto)', d]); }
casos.push(['01 USD + detracción (monto en PEN)', mk(3, '01', 'F001', { moneda: 'USD', tipoCambio: 3.75, operacion: 'servicios', detraccion: { codigo: '037' } })]);
casos.push(['01 bienes + guía T001 vinculada', mk(4, '01', 'F001', { operacion: 'bienes', items: bienes, guias: [{ serie: 'T001', numero: 25 }] })]);
casos.push(['08 nota de débito (intereses)', mk(5, '08', 'FD01', { items: [{ codigo: '', desc: 'Intereses moratorios', unidad: 'ZZ', cant: 1, precio: 120, afect: '10' }], ref: { tipo: '01', serie: 'F001', numero: base + 1, motivo: '01', sustento: 'Intereses por atraso' } })]);
casos.push(['07 nota de crédito (devolución)', mk(6, '07', 'FC01', { items: bienes.map(i => ({ ...i, cant: 1 })), ref: { tipo: '01', serie: 'F001', numero: base + 4, motivo: '07', sustento: 'Devolución de 1 laptop' } })]);
(async () => {
  const filtro = process.argv[2];
  for (const [nombre, d] of casos) {
    if (filtro && !nombre.includes(filtro)) continue;
    const errs = core.validarDoc(d, cfg, (n, cur) => cur === 'USD' ? n * 3.75 : n);
    if (errs.length) { console.log('VALIDACIÓN', nombre, errs); continue; }
    const xml = core.buildXML(d, cfg);
    require('fs').writeFileSync(`/tmp/beta-${d.tipo}-${d.numero}.xml`, xml);
    const t = Date.now();
    try {
      const r = await emitir({ xml, ruc: cfg.empresa.ruc, tipo: d.tipo, serie: d.serie, numero: d.numero, ambiente: 'beta', keyPem, certPem });
      console.log(`${r.estado.padEnd(9)} ${String(r.codigo).padEnd(5)} ${d.serie}-${d.numero}  ${nombre}\n          ${r.descripcion}${r.observaciones?.length ? '\n          OBS: ' + r.observaciones.join(' | ') : ''}  (${Date.now() - t} ms)`);
    } catch (e) { console.log('ERROR', nombre, e.message); }
  }
})();
