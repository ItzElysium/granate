const fs = require('fs');
const core = require('./ubl.js');
const { emitir } = require('./sunat.js');
const forge = require('node-forge'); const k = forge.pki.rsa.generateKeyPair(2048), c = forge.pki.createCertificate(); c.publicKey = k.publicKey; c.serialNumber = '01'; c.validity.notBefore = new Date(); c.validity.notAfter = new Date(Date.now() + 864e5); c.setSubject([{ name: 'commonName', value: 'Granate BETA' }]); c.setIssuer([{ name: 'commonName', value: 'Granate BETA' }]); c.sign(k.privateKey, forge.md.sha256.create()); const keyPem = forge.pki.privateKeyToPem(k.privateKey), certPem = forge.pki.certificateToPem(c);
const seed = core.buildSeed('2026-11-07'), cfg = seed.cfg;
const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const num = Number(process.argv[2] || Math.floor(Date.now() / 1000) % 90000000);
const mk = (tipo, serie, extra) => Object.assign({ tipo, serie, numero: num, fecha: today, hora: '12:00:00', moneda: 'PEN', incluyeIGV: false, igvRate: 0.18,
  cliente: { tipoDoc: '6', numDoc: '20000000028', nombre: 'Constructora Demo Norte S.A.C.', direccion: 'Av. Demo 456, Trujillo' },
  items: [{ codigo: 'P002', desc: 'Implementación de dashboard BI', unidad: 'ZZ', cant: 1, precio: 4800, afect: '10' }, { codigo: 'P001', desc: 'Consultoría especializada (hora)', unidad: 'HUR', cant: 2, precio: 180, afect: '10' }],
  formaPago: 'Contado', cuotas: [] }, extra || {});
(async () => {
  const which = process.argv[3] || '01';
  let d;
  if (which === '01') d = mk('01', 'F001');
  if (which === '01c') d = mk('01', 'F001', { formaPago: 'Credito', cuotas: [{ monto: 6088.8, fecha: '2026-12-31' }], vence: '2026-12-31' });
  if (which === '03') d = mk('03', 'B001', { cliente: { tipoDoc: '1', numDoc: '00000001', nombre: 'Carlos Mendoza', direccion: '' } });
  if (which === '03v') d = mk('03', 'B001', { cliente: { tipoDoc: '0', numDoc: '', nombre: 'Clientes varios', direccion: '' }, items: [{ codigo: 'P003', desc: 'Licencia', unidad: 'ZZ', cant: 2, precio: 95, afect: '10' }] });
  if (which === '07') d = mk('07', 'FC01', { ref: { tipo: '01', serie: 'F001', numero: 1, motivo: '07', sustento: 'Devolución parcial' } });
  if (which === 'usd') d = mk('01', 'F001', { moneda: 'USD', incluyeIGV: true });
  if (which === 'exo') d = mk('01', 'F001', { items: [{ codigo: 'X1', desc: 'Servicio exonerado', unidad: 'ZZ', cant: 1, precio: 100, afect: '20' }, { codigo: 'P001', desc: 'Consultoría', unidad: 'HUR', cant: 1, precio: 180, afect: '10' }] });
  const xml = core.buildXML(d, cfg);
  const t = Date.now();
  const r = await emitir({ xml, ruc: cfg.empresa.ruc, tipo: d.tipo, serie: d.serie, numero: d.numero, ambiente: 'beta', keyPem, certPem });
  fs.writeFileSync(`/tmp/last-${which}.xml`, r.xmlFirmado || '');
  console.log(which, `${d.serie}-${d.numero}`, r.estado, r.codigo, '|', r.descripcion, r.observaciones?.length ? JSON.stringify(r.observaciones) : '', `${Date.now() - t}ms`, 'hash', r.hash);
})().catch(e => console.error('ERR', e));
