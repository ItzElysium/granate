// npm run prueba:api · Prueba la API: base de transacciones + SUNAT beta real (factura con detracción) + GRE contra un SUNAT simulado
const { spawn } = require('child_process');
const http = require('http'), crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const JSZip = require('jszip');
const core = require('../ubl.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'granate-api-'));
const KEY = 'clave-de-prueba-123';
// certificado de prueba generado al vuelo (la producción simulada exige uno por archivo)
const forge = require('node-forge');
const kp = forge.pki.rsa.generateKeyPair(2048), crt = forge.pki.createCertificate();
crt.publicKey = kp.publicKey; crt.serialNumber = '01'; crt.validity.notBefore = new Date(); crt.validity.notAfter = new Date(Date.now() + 864e5);
crt.setSubject([{ name: 'commonName', value: 'Granate prueba' }]); crt.setIssuer([{ name: 'commonName', value: 'Granate prueba' }]); crt.sign(kp.privateKey, forge.md.sha256.create());
const KEY_PEM = path.join(tmp, 'key.pem'), CERT_PEM = path.join(tmp, 'cert.pem');
fs.writeFileSync(KEY_PEM, forge.pki.privateKeyToPem(kp.privateKey)); fs.writeFileSync(CERT_PEM, forge.pki.certificateToPem(crt));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) process.exitCode = 1; };

// ---------- SUNAT GRE simulado ----------
let recibido = null, consultas = 0;
const mock = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const j = (st, o) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.includes('/oauth2/token/')) { const f = new URLSearchParams(b); recibido = { ...recibido, token: Object.fromEntries(f) }; return j(200, { access_token: 'tok-123', token_type: 'JWT', expires_in: 3600 }); }
  if (req.method === 'POST' && req.url.includes('/contribuyente/gem/comprobantes/')) {
    const body = JSON.parse(b); const buf = Buffer.from(body.archivo.arcGreZip, 'base64');
    recibido = { ...recibido, auth: req.headers.authorization, url: req.url, body, hashOk: crypto.createHash('sha256').update(buf).digest('hex') === body.archivo.hashZip, zip: await JSZip.loadAsync(buf) };
    return j(200, { numTicket: 'b6d0f2b5-0000-4000-8000-000000000001', fecRecepcion: new Date().toISOString() });
  }
  if (req.url.includes('/envios/')) {
    consultas++;
    if (consultas < 2) return j(200, { codRespuesta: '98' });
    const z = new JSZip(); z.file('R-20000000001-09-T001-7.xml', '<?xml version="1.0"?><ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cac:DocumentResponse><cac:Response><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>La Guia numero T001-7, ha sido aceptada</cbc:Description></cac:Response></cac:DocumentResponse></ar:ApplicationResponse>');
    return j(200, { codRespuesta: '0', indCdrGenerado: '1', arcCdr: await z.generateAsync({ type: 'base64' }) });
  }
  j(404, {});
}).listen(7199);

const arrancar = (port, extra) => new Promise(res => {
  const p = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: port, GRANATE_API_KEY: KEY, GRANATE_DB: path.join(tmp, `g${port}.db`), PADRON_DB: path.join(tmp, 'no.db'), PADRON_REPO: '', ...extra } });
  p.stdout.on('data', d => { const t = String(d); if (t.includes('puerto')) res(p); });
  p.stderr.on('data', d => process.stderr.write('[api] ' + d));
});
const api = (port, ruta, opt = {}) => fetch(`http://localhost:${port}${ruta}`, { ...opt, headers: { 'Content-Type': 'application/json', 'X-Granate-Key': KEY, ...(opt.headers || {}) } });

(async () => {
  const beta = await arrancar(7171, { SUNAT_AMBIENTE: 'beta' });
  const prod = await arrancar(7172, { SUNAT_AMBIENTE: 'produccion', SUNAT_USUARIO_SOL: 'USUPRUEB', SUNAT_CLAVE_SOL: 'clave', CERT_KEY_PATH: KEY_PEM, CERT_PEM_PATH: CERT_PEM, SUNAT_GRE_CLIENT_ID: 'cli-123', SUNAT_GRE_CLIENT_SECRET: 'sec-456', SUNAT_GRE_TOKEN_URL: 'http://localhost:7199/v1/clientessol', SUNAT_GRE_API_URL: 'http://localhost:7199/v1' });
  try {
    const h = await (await fetch('http://localhost:7171/health')).json();
    ok(h.ok && h.base && h.protegida, `health: base ${h.base?.ruta ? 'abierta' : '—'}, protegida=${h.protegida}`);
    ok((await fetch('http://localhost:7171/bitacora')).status === 401, 'sin clave → 401');
    // ---- factura de servicios con detracción al beta real de SUNAT
    const seed = core.buildSeed('2026-11-07'), cfg = seed.cfg;
    const n = Math.floor(Date.now() / 1000) % 9000000 + 300;
    const d = { id: 'doc-prueba', tipo: '01', serie: 'F001', numero: n, fecha: new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10), hora: '12:00:00', moneda: 'PEN', igvRate: 0.18, operacion: 'servicios', detraccion: { codigo: '037' }, formaPago: 'Contado', cuotas: [], cliente: { tipoDoc: '6', numDoc: '20000000028', nombre: 'Constructora Demo Norte S.A.C.' }, items: [{ codigo: 'P002', desc: 'Implementación de dashboard BI', unidad: 'ZZ', cant: 1, precio: 4800, afect: '10' }] };
    d.totales = { total: core.calc(d).total, detraccion: core.spot(d, 3.5).monto };
    const r1 = await (await api(7171, '/cpe/emitir', { method: 'POST', body: JSON.stringify({ ambiente: 'beta', emisor: { ruc: cfg.empresa.ruc }, documento: d, xml: core.buildXML(d, cfg) }) })).json();
    ok(r1.estado === 'ACEPTADO', `SUNAT beta: ${r1.estado} ${r1.codigo} · ${r1.descripcion}`);
    const k = r1.clave;
    const f = await (await api(7171, `/documentos/${k}`)).json();
    ok(f.estado === 'aceptado' && f.envios.length === 1 && f.envios[0].xml_bytes > 1000 && f.envios[0].cdr_bytes > 100 && f.detraccion === 680, `ficha: estado=${f.estado}, envíos=${f.envios.length}, XML ${f.envios[0]?.xml_bytes} B, CDR ${f.envios[0]?.cdr_bytes} B, detracción ${f.detraccion}`);
    const xml = await (await api(7171, `/documentos/${k}/xml`)).text();
    ok(xml.includes('<ds:Signature') && xml.includes('<cbc:PaymentMeansID>037</cbc:PaymentMeansID>'), 'XML firmado guardado con la detracción 037');
    const cdr = Buffer.from(await (await api(7171, `/documentos/${k}/cdr`)).arrayBuffer());
    ok(cdr.subarray(0, 2).toString() === 'PK', `CDR guardado (ZIP de ${cdr.length} B)`);
    // ---- bitácora y archivo PDF
    await api(7171, '/bitacora', { method: 'POST', body: JSON.stringify({ id: 'ev-1', ts: new Date().toISOString(), evento: 'cobro.registrado', docId: 'doc-prueba', tipo: '01', docNum: `F001-${n}`, monto: 5664, detalle: 'prueba', ruc: cfg.empresa.ruc }) });
    const bit = await (await api(7171, '/bitacora?limite=10')).json();
    ok(bit.datos.some(e => e.evento === 'cobro.registrado') && bit.datos.some(e => e.evento === 'sunat.aceptado' && e.origen === 'api'), `bitácora: ${bit.datos.map(e => e.evento).join(', ')}`);
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 32), Buffer.from('\n%%EOF')]);
    const a = await (await api(7171, '/archivo', { method: 'POST', body: JSON.stringify({ ruc: cfg.empresa.ruc, docId: 'doc-prueba', tipo: '01', serie: 'F001', numero: n, version: 1, nombre: `Factura-F001-${n}.pdf`, nota: 'Aceptado por SUNAT', pdfBase64: pdf.toString('base64') }) })).json();
    const back = Buffer.from(await (await api(7171, `/archivo/${a.id}/pdf`)).arrayBuffer());
    ok(back.equals(pdf), `PDF archivado y recuperado idéntico (${back.length} B, id ${a.id.slice(0, 8)}…)`);
    ok((await api(7171, '/archivo', { method: 'POST', body: JSON.stringify({ pdfBase64: Buffer.from('no soy un pdf').toString('base64') }) })).status === 400, 'rechaza archivos que no son PDF');
    const f2 = await (await api(7171, `/documentos/${k}`)).json();
    ok(f2.archivos.length === 1, 'la ficha del documento lista su copia PDF');
    const cor = await (await api(7171, '/correlativos')).json();
    ok(cor.datos[0].serie === 'F001' && cor.datos[0].faltan.length > 0, `correlativos: F001 emitidos ${cor.datos[0].emitidos}, saltos detectados ${cor.datos[0].faltan.length}+ (beta usa números altos)`);
    // ---- guía de remisión contra SUNAT simulado
    const g = { id: 'gre-prueba', tipo: '09', serie: 'T001', numero: 7, fecha: d.fecha, hora: '09:00:00', cliente: { tipoDoc: '6', numDoc: '20000000028', nombre: 'Constructora Demo Norte S.A.C.' }, items: [{ codigo: 'P005', desc: 'Laptop', unidad: 'NIU', cant: 2 }],
      traslado: { motivo: '01', fechaInicio: d.fecha, modalidad: '02', pesoKg: 5.7, bultos: 2, partida: { ubigeo: '150131', direccion: 'Av. Ejemplo 123' }, llegada: { ubigeo: '130101', direccion: 'Av. Demo 456, Trujillo' }, conductor: { numDoc: '00000002', nombres: 'Luis', apellidos: 'Quispe', licencia: 'Q00000002' }, placa: 'ABC123', transportista: {} } };
    ok(core.validarDoc(g, cfg, x => x).length === 0, 'la guía de prueba pasa las validaciones');
    const gb = await (await api(7171, '/gre/emitir', { method: 'POST', body: JSON.stringify({ emisor: { ruc: cfg.empresa.ruc }, documento: g, xml: core.buildXML(g, cfg) }) })).json();
    ok(/no ofrece ambiente beta/.test(gb.mensaje), 'en beta la API explica que SUNAT no tiene beta de GRE');
    const t0 = Date.now();
    const gr = await (await api(7172, '/gre/emitir', { method: 'POST', body: JSON.stringify({ emisor: { ruc: cfg.empresa.ruc }, documento: g, xml: core.buildXML(g, cfg) }) })).json();
    ok(gr.estado === 'ACEPTADO' && gr.ticket, `GRE: ${gr.estado} ${gr.codigo} · ${gr.descripcion} · ticket ${gr.ticket} (${Date.now() - t0} ms, ${consultas} consultas)`);
    ok(recibido.token.grant_type === 'password' && recibido.token.username === '20000000001USUPRUEB' && recibido.token.scope === 'https://api-cpe.sunat.gob.pe' && recibido.token.client_id === 'cli-123', 'token OAuth2: grant password, usuario RUC+SOL, scope api-cpe');
    ok(recibido.auth === 'Bearer tok-123' && recibido.url.endsWith('/comprobantes/20000000001-09-T001-7') && recibido.body.archivo.nomArchivo === '20000000001-09-T001-7.zip', 'envío: Bearer + nombre RUC-09-SERIE-NÚMERO');
    ok(recibido.hashOk, 'hashZip = SHA-256 del ZIP enviado');
    const gx = await recibido.zip.file('20000000001-09-T001-7.xml').async('string');
    ok(gx.includes('<DespatchAdvice') && gx.includes('<ds:Signature') && gx.includes('>SUNAT_Envio<') && gx.includes('<cbc:LicensePlateID>') === false && gx.includes('<cac:TransportEquipment><cbc:ID>ABC123</cbc:ID>'), 'ZIP con DespatchAdvice firmado (placa, conductor y ubigeos)');
    const rep = await (await api(7172, '/gre/emitir', { method: 'POST', body: JSON.stringify({ emisor: { ruc: cfg.empresa.ruc }, documento: g, xml: core.buildXML(g, cfg) }) })).json();
    ok(rep.repetido && rep.estado === 'ACEPTADO', 'reenviar una guía ya aceptada no la duplica: devuelve la constancia guardada');
  } finally { beta.kill(); prod.kill(); mock.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
