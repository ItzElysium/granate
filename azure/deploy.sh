#!/usr/bin/env bash
# =====================================================================
# Granate nube · despliegue en Azure (ejecutar en Azure Cloud Shell, Bash)
#   git clone https://github.com/renzotomascoronado-sudo/facturacionelectronica.git ~/facturacionelectronica || git -C ~/facturacionelectronica pull
#   bash ~/facturacionelectronica/azure/deploy.sh
# Crea (o actualiza) en la suscripción activa:
#   - Grupo de recursos rg-granate
#   - Cosmos DB (nivel gratis si está disponible; si no, modo serverless): base "granate", contenedores datos y cuentas
#   - Cuenta de almacenamiento (Functions + copias PDF)
#   - Function App Flex Consumption (Node 22) con la API de datos
#   - CORS para la web publicada y un código de instalación de un solo uso
# Variables opcionales: RG, REGION, ORIGEN, NUEVO_CODIGO=1 (genera otro código de instalación)
# =====================================================================
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
RG="${RG:-rg-granate}"
ORIGEN="${ORIGEN:-https://renzotomascoronado-sudo.github.io}"
SUB="$(az account show --query id -o tsv)"
SUF="$(printf '%s' "$SUB$RG" | sha1sum | cut -c1-6)"
COS="granate-db-$SUF"; ST="granatest$SUF"; FN="granate-nube-$SUF"
paso() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

paso "Suscripción: $(az account show --query name -o tsv) ($SUB)"
# Proveedores que la suscripción debe tener registrados (las suscripciones nuevas o de estudiante no los traen activos)
for p in Microsoft.DocumentDB Microsoft.Web Microsoft.Storage Microsoft.Insights Microsoft.OperationalInsights; do
  [ "$(az provider show -n "$p" --query registrationState -o tsv 2>/dev/null)" = Registered ] || { echo "Registrando $p…"; az provider register -n "$p" --wait -o none; }
done
# Región: la primera candidata permitida por la suscripción y con Functions Flex Consumption
FLEX="$(az functionapp list-flexconsumption-locations --query '[].name' -o tsv 2>/dev/null | tr '\t' '\n' | tr '[:upper:]' '[:lower:]' | tr -d ' ' || true)"
PERM="$(az policy assignment show --name sys.regionrestriction --query 'parameters.listOfAllowedLocations.value' -o tsv 2>/dev/null | tr '\t' '\n' | tr '[:upper:]' '[:lower:]' || true)"
R=""
for c in ${REGION:-chilecentral mexicocentral canadacentral brazilsouth eastus2 centralus}; do
  if [ -n "$PERM" ] && ! grep -qx "$c" <<<"$PERM"; then continue; fi
  if [ -n "$FLEX" ] && ! grep -qx "$c" <<<"$FLEX"; then continue; fi
  R="$c"; break
done
[ -n "$R" ] || { echo "No encontré una región permitida con Functions Flex. Regiones permitidas: $PERM"; exit 1; }
paso "Región: $R · grupo: $RG"
az group create -n "$RG" -l "$R" -o none

paso "Cosmos DB ($COS) · puede tardar de 5 a 10 minutos la primera vez"
if ! az cosmosdb show -n "$COS" -g "$RG" -o none 2>/dev/null; then
  if [ -z "$(az cosmosdb list --query '[?enableFreeTier].id' -o tsv)" ]; then
    az cosmosdb create -n "$COS" -g "$RG" --locations regionName="$R" failoverPriority=0 isZoneRedundant=False \
      --enable-free-tier true --default-consistency-level Session -o none
    MODO=gratis
  else
    echo "La suscripción ya usa el nivel gratis de Cosmos en otra cuenta: se crea en modo serverless (pago por uso)."
    az cosmosdb create -n "$COS" -g "$RG" --locations regionName="$R" failoverPriority=0 isZoneRedundant=False \
      --capabilities EnableServerless --default-consistency-level Session -o none
    MODO=serverless
  fi
else
  MODO="$(az cosmosdb show -n "$COS" -g "$RG" --query 'enableFreeTier' -o tsv | sed 's/true/gratis/;s/false/serverless/')"
fi
if ! az cosmosdb sql database show -a "$COS" -g "$RG" -n granate -o none 2>/dev/null; then
  if [ "$MODO" = gratis ]; then az cosmosdb sql database create -a "$COS" -g "$RG" -n granate --throughput 1000 -o none
  else az cosmosdb sql database create -a "$COS" -g "$RG" -n granate -o none; fi
fi
IDX="$(mktemp)"; cat >"$IDX" <<'JSON'
{ "indexingMode": "consistent", "automatic": true, "includedPaths": [ { "path": "/*" } ], "excludedPaths": [ { "path": "/data/*" }, { "path": "/\"_etag\"/?" } ] }
JSON
az cosmosdb sql container show -a "$COS" -g "$RG" -d granate -n datos -o none 2>/dev/null || \
  az cosmosdb sql container create -a "$COS" -g "$RG" -d granate -n datos -p /empresa --idx @"$IDX" -o none
az cosmosdb sql container show -a "$COS" -g "$RG" -d granate -n cuentas -o none 2>/dev/null || \
  az cosmosdb sql container create -a "$COS" -g "$RG" -d granate -n cuentas -p /id -o none

paso "Almacenamiento ($ST)"
az storage account show -n "$ST" -g "$RG" -o none 2>/dev/null || \
  az storage account create -n "$ST" -g "$RG" -l "$R" --sku Standard_LRS --kind StorageV2 --allow-blob-public-access false --min-tls-version TLS1_2 -o none

paso "Function App ($FN) · Flex Consumption, Node 22"
az functionapp show -n "$FN" -g "$RG" -o none 2>/dev/null || \
  az functionapp create -g "$RG" -n "$FN" --storage-account "$ST" --flexconsumption-location "$R" --runtime node --runtime-version 22 --instance-memory 512 -o none

paso "Configuración (las claves pasan directo de Azure a la app, no se muestran)"
CEND="$(az cosmosdb show -n "$COS" -g "$RG" --query documentEndpoint -o tsv)"
CKEY="$(az cosmosdb keys list -n "$COS" -g "$RG" --query primaryMasterKey -o tsv)"
SCONN="$(az storage account show-connection-string -n "$ST" -g "$RG" --query connectionString -o tsv)"
CODIGO=""
if [ "${NUEVO_CODIGO:-0}" = 1 ] || [ -z "$(az functionapp config appsettings list -g "$RG" -n "$FN" --query "[?name=='SETUP_HASH'].value" -o tsv)" ]; then
  A="$(python3 -c "import secrets;print(''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(4)))")"
  B="$(python3 -c "import secrets;print(''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(4)))")"
  CODIGO="GRN-$A-$B"
  HASH="$(printf 'GRN%s%s' "$A" "$B" | sha256sum | cut -d' ' -f1)"
  az functionapp config appsettings set -g "$RG" -n "$FN" -o none --settings "SETUP_HASH=$HASH"
fi
az functionapp config appsettings set -g "$RG" -n "$FN" -o none --settings \
  "COSMOS_ENDPOINT=$CEND" "COSMOS_KEY=$CKEY" "COSMOS_DB=granate" "ARCHIVOS_CONN=$SCONN" "ARCHIVOS_CONTENEDOR=archivos"
az functionapp cors remove -g "$RG" -n "$FN" --allowed-origins "$ORIGEN" -o none 2>/dev/null || true
az functionapp cors add -g "$RG" -n "$FN" --allowed-origins "$ORIGEN" -o none

paso "Publicando el código de la API"
APIDIR="$(mktemp -d)"
if [ -f "$DIR/api/src/nucleo.js" ]; then cp -r "$DIR/api/." "$APIDIR/"; else
mkdir -p "$APIDIR/."
cat > "$APIDIR/package.json" <<'GRANATE_EOF'
{
  "name": "granate-nube",
  "version": "1.0.0",
  "description": "Granate · API de datos en Azure Functions + Cosmos DB (usuarios, sincronización, numeración, copias PDF)",
  "main": "src/index.js",
  "private": true,
  "engines": { "node": ">=22" },
  "dependencies": {
    "@azure/cosmos": "^4.2.0",
    "@azure/functions": "^4.6.0",
    "@azure/storage-blob": "^12.26.0"
  }
}
GRANATE_EOF
mkdir -p "$APIDIR/."
cat > "$APIDIR/host.json" <<'GRANATE_EOF'
{
  "version": "2.0",
  "extensions": { "http": { "routePrefix": "api" } },
  "logging": { "applicationInsights": { "samplingSettings": { "isEnabled": true, "excludedTypes": "Request" } } }
}
GRANATE_EOF
mkdir -p "$APIDIR/src"
cat > "$APIDIR/src/index.js" <<'GRANATE_EOF'
'use strict';
/* Granate nube · punto de entrada en Azure Functions (modelo v4 de Node). Una sola función atiende todas las rutas /api/*. */
const { app } = require('@azure/functions');
const { crearNucleo } = require('./nucleo');
const { crearAlmacen } = require('./almacen');

let nucleo = null;
const obtener = () => (nucleo ||= crearNucleo({ store: crearAlmacen(process.env), setupHash: process.env.SETUP_HASH || '' }));

app.http('api', {
  route: '{*ruta}',
  methods: ['GET', 'POST', 'PATCH'],
  authLevel: 'anonymous',
  handler: async req => {
    let body = null;
    if (req.method !== 'GET') { try { body = await req.json(); } catch { body = null; } }
    const r = await obtener().handle({
      method: req.method,
      path: req.params.ruta || '',
      query: Object.fromEntries(req.query.entries()),
      headers: { authorization: req.headers.get('authorization') || '' },
      body,
    });
    const headers = { ...r.headers, 'X-Content-Type-Options': 'nosniff' };
    return Buffer.isBuffer(r.body) ? { status: r.status, headers, body: r.body } : { status: r.status, headers, jsonBody: r.body };
  },
});
GRANATE_EOF
mkdir -p "$APIDIR/src"
cat > "$APIDIR/src/nucleo.js" <<'GRANATE_EOF'
'use strict';
/* =====================================================================
   Granate nube · núcleo de la API de datos (sin dependencias de Azure)
   - Usuarios por empresa (RUC) con roles: admin, contador, vendedor
   - Datos de la app sincronizados por marca de tiempo (_ts de Cosmos)
   - Numeración atómica por tipo y serie: dos equipos nunca reciben el mismo número
   - Copias PDF en almacenamiento de archivos
   El almacén se inyecta: Cosmos DB + Blob en Azure, o memoria en las pruebas.
   ===================================================================== */
const crypto = require('crypto');

const VERSION = '1.0.0';
const COLS = new Set(['clientes', 'productos', 'documentos', 'movimientos', 'archivo', 'config']);
const ROLES = { admin: 'Administrador', contador: 'Contador', vendedor: 'Vendedor' };
const TIPOS_NUM = new Set(['01', '03', '07', '08', '09', '31', 'COT', 'NV']);
const DIA = 86400;

const fallo = (status, mensaje, extra = {}) => Object.assign(new Error(mensaje), { status, mensaje, ...extra });
const normEmail = e => String(e || '').trim().toLowerCase();
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const normCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const idOk = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(id);

function hashClave(clave, sal = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(clave), sal, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${sal}$${h}`;
}
function claveOk(clave, guardado) {
  const [alg, sal, h] = String(guardado || '').split('$');
  if (alg !== 'scrypt' || !sal || !h) return false;
  const x = crypto.scryptSync(String(clave), sal, 32, { N: 16384, r: 8, p: 1 });
  const y = Buffer.from(h, 'hex');
  return y.length === x.length && crypto.timingSafeEqual(x, y);
}
function claveTemporal() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (const b of crypto.randomBytes(12)) s += abc[b % abc.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
function firmar(payload, key) {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', key).update(p).digest('base64url')}`;
}
function leerToken(tok, key, ahora) {
  const [p, s] = String(tok || '').split('.');
  if (!p || !s) return null;
  const e = crypto.createHmac('sha256', key).update(p).digest('base64url');
  if (e.length !== s.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s))) return null;
  try { const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return j.exp && j.exp > ahora ? j : null; } catch { return null; }
}
const publico = u => ({ email: u.id, nombre: u.nombre || '', rol: u.rol, activo: u.activo !== false, debeCambiar: !!u.debeCambiar, creado: u.creado || '', ultimoIngreso: u.ultimoIngreso || '' });

function crearNucleo({ store, setupHash = '', reloj = () => Date.now() }) {
  const seg = () => Math.floor(reloj() / 1000);
  const iso = () => new Date(reloj()).toISOString();
  let jwtKey = null;

  async function sistema() {
    let s = await store.cuenta('_sistema');
    if (!s) {
      try { s = await store.crearCuenta({ id: '_sistema', tipo: 'sistema', jwtKey: crypto.randomBytes(32).toString('hex'), creado: iso() }); }
      catch (e) { if (e.code !== 409) throw e; s = await store.cuenta('_sistema'); }
    }
    return s;
  }
  async function clave() { if (!jwtKey) jwtKey = (await sistema()).jwtKey; return jwtKey; }
  async function emitirToken(u) { return firmar({ sub: u.id, emp: u.empresa, rol: u.rol, ver: u.ver || 1, exp: seg() + 30 * DIA }, await clave()); }
  async function sesionDe(u) {
    const emp = await store.cuenta(`empresa:${u.empresa}`);
    return { token: await emitirToken(u), usuario: publico(u), empresa: { ruc: u.empresa, razon: emp?.razon || '' } };
  }

  async function autenticar(headers) {
    const m = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
    if (!m) throw fallo(401, 'Inicia sesión para continuar.');
    const t = leerToken(m[1], await clave(), seg());
    if (!t) throw fallo(401, 'Tu sesión venció. Vuelve a ingresar.');
    const u = await store.usuario(t.sub);
    if (!u || u.activo === false || u.empresa !== t.emp || (u.ver || 1) !== t.ver) throw fallo(401, 'Tu sesión ya no es válida. Vuelve a ingresar.');
    return u;
  }
  const exigir = (u, ...roles) => { if (!roles.includes(u.rol)) throw fallo(403, 'Tu usuario no tiene permiso para esta acción.'); };

  /* ---------- instalación y acceso ---------- */
  async function instalar(b) {
    if (!setupHash) throw fallo(403, 'La instalación no está habilitada en este servidor.');
    const s = await sistema();
    if ((s.bloqueoInstalar || 0) > seg()) throw fallo(429, 'Demasiados intentos con el código. Espera 30 minutos.');
    if (sha256(normCodigo(b.codigo)) !== setupHash) {
      s.fallosInstalar = (s.fallosInstalar || 0) + 1;
      if (s.fallosInstalar >= 5) { s.fallosInstalar = 0; s.bloqueoInstalar = seg() + 1800; }
      await store.guardarCuenta(s);
      throw fallo(401, 'El código de instalación no es correcto.');
    }
    const ruc = String(b.ruc || '').trim(), email = normEmail(b.email), nombre = String(b.nombre || '').trim().slice(0, 80);
    if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) throw fallo(400, 'Escribe un RUC válido de 11 dígitos.');
    if (!emailOk(email)) throw fallo(400, 'Escribe un correo válido.');
    if (!nombre) throw fallo(400, 'Escribe tu nombre.');
    if (String(b.clave || '').length < 8) throw fallo(400, 'La contraseña debe tener al menos 8 caracteres.');
    if (await store.cuenta(`empresa:${ruc}`)) throw fallo(409, 'Esta empresa ya está instalada. Ingresa con tu correo y contraseña.');
    if (await store.usuario(email)) throw fallo(409, 'Ese correo ya tiene un usuario. Ingresa con él.');
    await store.crearCuenta({ id: `empresa:${ruc}`, tipo: 'empresa', ruc, razon: String(b.razon || '').trim().slice(0, 160), creado: iso(), creadoPor: email });
    const u = { id: email, tipo: 'usuario', empresa: ruc, nombre, rol: 'admin', clave: hashClave(b.clave), activo: true, ver: 1, debeCambiar: false, fallos: 0, creado: iso(), ultimoIngreso: iso() };
    await store.guardarUsuario(u);
    if (s.fallosInstalar) { s.fallosInstalar = 0; await store.guardarCuenta(s); }
    return sesionDe(u);
  }

  async function ingresar(b) {
    const email = normEmail(b.email);
    const u = emailOk(email) ? await store.usuario(email) : null;
    if (!u || u.activo === false) throw fallo(401, 'Correo o contraseña incorrectos.');
    if ((u.bloqueadoHasta || 0) > seg()) throw fallo(429, 'Demasiados intentos fallidos. Espera 15 minutos o pide al administrador que te asigne una contraseña nueva.');
    if (!claveOk(b.clave, u.clave)) {
      u.fallos = (u.fallos || 0) + 1;
      if (u.fallos >= 8) { u.fallos = 0; u.bloqueadoHasta = seg() + 900; }
      await store.guardarUsuario(u);
      throw fallo(401, 'Correo o contraseña incorrectos.');
    }
    u.fallos = 0; u.bloqueadoHasta = 0; u.ultimoIngreso = iso();
    await store.guardarUsuario(u);
    return sesionDe(u);
  }

  async function cambiarClave(u, b) {
    if (!claveOk(b.actual, u.clave)) throw fallo(400, 'La contraseña actual no es correcta.');
    if (String(b.nueva || '').length < 8) throw fallo(400, 'La nueva contraseña debe tener al menos 8 caracteres.');
    if (b.nueva === b.actual) throw fallo(400, 'La nueva contraseña debe ser distinta de la actual.');
    u.clave = hashClave(b.nueva); u.debeCambiar = false; u.ver = (u.ver || 1) + 1;
    await store.guardarUsuario(u);
    return sesionDe(u);
  }

  /* ---------- usuarios (solo administrador) ---------- */
  async function listarUsuarios(u) {
    exigir(u, 'admin');
    const lista = (await store.usuariosDe(u.empresa)).map(publico);
    return { usuarios: lista.sort((a, b) => Number(b.activo) - Number(a.activo) || a.nombre.localeCompare(b.nombre)) };
  }
  async function crearUsuario(u, b) {
    exigir(u, 'admin');
    const email = normEmail(b.email), nombre = String(b.nombre || '').trim().slice(0, 80), rol = String(b.rol || 'vendedor');
    if (!emailOk(email)) throw fallo(400, 'Escribe un correo válido.');
    if (!nombre) throw fallo(400, 'Escribe el nombre de la persona.');
    if (!ROLES[rol]) throw fallo(400, 'Elige un rol válido.');
    const prev = await store.usuario(email);
    if (prev && prev.empresa !== u.empresa) throw fallo(409, 'Ese correo ya está registrado en otra empresa.');
    if (prev && prev.activo !== false) throw fallo(409, 'Ese correo ya tiene un usuario activo.');
    const temp = claveTemporal();
    const n = { ...(prev || {}), id: email, tipo: 'usuario', empresa: u.empresa, nombre, rol, clave: hashClave(temp), activo: true, ver: (prev?.ver || 0) + 1, debeCambiar: true, fallos: 0, bloqueadoHasta: 0, creado: prev?.creado || iso(), creadoPor: u.id };
    await store.guardarUsuario(n);
    return { usuario: publico(n), claveTemporal: temp };
  }
  async function editarUsuario(u, email, b) {
    exigir(u, 'admin');
    const t = await store.usuario(normEmail(email));
    if (!t || t.empresa !== u.empresa) throw fallo(404, 'No encontramos ese usuario.');
    const yo = t.id === u.id;
    let temp = '';
    if (b.nombre !== undefined) { const n = String(b.nombre).trim().slice(0, 80); if (!n) throw fallo(400, 'Escribe el nombre.'); t.nombre = n; }
    if (b.rol !== undefined && b.rol !== t.rol) {
      if (!ROLES[b.rol]) throw fallo(400, 'Elige un rol válido.');
      if (yo) throw fallo(400, 'No puedes cambiar tu propio rol. Pide a otro administrador que lo haga.');
      t.rol = b.rol; t.ver = (t.ver || 1) + 1;
    }
    if (b.activo !== undefined && Boolean(b.activo) !== (t.activo !== false)) {
      if (yo) throw fallo(400, 'No puedes desactivar tu propio usuario.');
      t.activo = Boolean(b.activo); t.ver = (t.ver || 1) + 1;
    }
    if (b.nuevaClave) {
      if (yo) throw fallo(400, 'Para cambiar tu contraseña usa «Cambiar mi contraseña».');
      temp = claveTemporal(); t.clave = hashClave(temp); t.debeCambiar = true; t.fallos = 0; t.bloqueadoHasta = 0; t.ver = (t.ver || 1) + 1;
    }
    await store.guardarUsuario(t);
    return { usuario: publico(t), ...(temp ? { claveTemporal: temp } : {}) };
  }

  /* ---------- datos ---------- */
  async function leerDatos(u, q) {
    const desde = Math.max(0, Math.floor(Number(q.desde) || 0));
    const r = await store.desde(u.empresa, desde, q.cont || null, 400);
    let hasta = desde;
    const items = r.items.map(x => { hasta = Math.max(hasta, x._ts || 0); return { col: x.col, id: x.oid, data: x.borrado ? null : x.data, borrado: !!x.borrado, ts: x._ts || 0, por: x.por || '' }; });
    return { items, cont: r.cont || null, hasta };
  }
  async function escribirDatos(u, b) {
    const lista = Array.isArray(b?.items) ? b.items : [];
    if (!lista.length) return { items: [], hasta: 0 };
    if (lista.length > 200) throw fallo(400, 'Envía como máximo 200 registros por vez.');
    const docs = lista.map(it => {
      const col = String(it?.col || ''), id = it?.borrado ? it.id : it?.obj?.id;
      if (!COLS.has(col)) throw fallo(400, `Colección no válida: ${col}`);
      if (!idOk(id)) throw fallo(400, 'Identificador de registro no válido.');
      if (col === 'config') exigir(u, 'admin', 'contador');
      const base = { id: `${col}:${id}`, empresa: u.empresa, col, oid: id, por: u.id, ts: iso() };
      if (it.borrado) return { ...base, borrado: true, data: null };
      const obj = it.obj;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw fallo(400, 'Registro vacío.');
      if (JSON.stringify(obj).length > 1500000) throw fallo(413, 'El registro es demasiado grande.');
      const doc = { ...base, data: obj };
      if (col === 'documentos') { doc.tipo = String(obj.tipo || ''); doc.serie = String(obj.serie || ''); doc.numero = Number(obj.numero) || null; }
      return doc;
    });
    const out = []; let hasta = 0;
    for (let i = 0; i < docs.length; i += 5) {
      const lote = await Promise.all(docs.slice(i, i + 5).map(d => store.guardar(d)));
      for (const g of lote) { hasta = Math.max(hasta, g._ts || 0); out.push({ col: g.col, id: g.oid, ts: g._ts || 0 }); }
    }
    return { items: out, hasta };
  }

  async function reservarNumero(u, b) {
    const tipo = String(b?.tipo || ''), serie = String(b?.serie || '').toUpperCase();
    if (!TIPOS_NUM.has(tipo)) throw fallo(400, 'Tipo de documento no válido.');
    if (!/^[A-Z0-9]{4}$/.test(serie)) throw fallo(400, 'Serie no válida.');
    const id = `num:${u.empresa}:${tipo}:${serie}`;
    for (let i = 0; i < 30; i++) {
      if (i) await new Promise(r => setTimeout(r, 15 + Math.random() * 60 * Math.min(i, 6)));
      const [cur, maxD] = await Promise.all([store.contador(id), store.maxNumero(u.empresa, tipo, serie)]);
      try {
        if (!cur) { const n = maxD + 1; await store.crearCuenta({ id, tipo: 'contador', empresa: u.empresa, doc: tipo, serie, ultimo: n, ts: iso(), por: u.id }); return { numero: n }; }
        const n = Math.max(Number(cur.doc.ultimo) || 0, maxD) + 1;
        await store.reemplazarContador({ ...cur.doc, ultimo: n, ts: iso(), por: u.id }, cur.etag);
        return { numero: n };
      } catch (e) { if (e.code !== 409 && e.code !== 412) throw e; }
    }
    throw fallo(503, 'Muchas emisiones al mismo tiempo. Intenta de nuevo.');
  }

  /* ---------- archivos (copias PDF) ---------- */
  async function subirArchivo(u, b) {
    const nombre = String(b?.nombre || 'archivo.pdf').replace(/[^\w.\- ]/g, '_').slice(0, 120);
    const tipo = /^[\w.+-]+\/[\w.+-]+$/.test(b?.tipo || '') ? b.tipo : 'application/pdf';
    const buf = Buffer.from(String(b?.base64 || ''), 'base64');
    if (!buf.length) throw fallo(400, 'Archivo vacío.');
    if (buf.length > 8 * 1024 * 1024) throw fallo(413, 'El archivo supera 8 MB.');
    const ruta = `${u.empresa}/${iso().slice(0, 7)}/${crypto.randomUUID()}-${nombre}`;
    await store.subirArchivo(ruta, buf, tipo);
    return { ref: ruta, bytes: buf.length };
  }
  async function bajarArchivo(u, ruta) {
    if (!ruta.startsWith(`${u.empresa}/`) || ruta.includes('..')) throw fallo(404, 'Archivo no encontrado.');
    const a = await store.bajarArchivo(ruta);
    if (!a) throw fallo(404, 'Archivo no encontrado.');
    return a;
  }

  /* ---------- enrutador ---------- */
  async function handle(req) {
    const metodo = String(req.method || 'GET').toUpperCase();
    const path = '/' + String(req.path || '').replace(/^\/+|\/+$/g, '');
    const q = req.query || {}, b = req.body || {}, h = req.headers || {};
    try {
      if (metodo === 'GET' && (path === '/' || path === '/salud')) return ok({ ok: true, servicio: 'granate-nube', version: VERSION, instalable: !!setupHash, hora: iso() });
      if (metodo === 'POST' && path === '/auth/instalar') return ok(await instalar(b));
      if (metodo === 'POST' && path === '/auth/ingresar') return ok(await ingresar(b));
      const u = await autenticar(h);
      if (metodo === 'GET' && path === '/auth/yo') return ok(await sesionDe(u));
      if (metodo === 'POST' && path === '/auth/clave') return ok(await cambiarClave(u, b));
      if (metodo === 'GET' && path === '/usuarios') return ok(await listarUsuarios(u));
      if (metodo === 'POST' && path === '/usuarios') return ok(await crearUsuario(u, b));
      if (metodo === 'PATCH' && path.startsWith('/usuarios/')) return ok(await editarUsuario(u, decodeURIComponent(path.slice(10)), b));
      if (metodo === 'GET' && path === '/datos') return ok(await leerDatos(u, q));
      if (metodo === 'POST' && path === '/datos') return ok(await escribirDatos(u, b));
      if (metodo === 'POST' && path === '/numero') return ok(await reservarNumero(u, b));
      if (metodo === 'POST' && path === '/archivos') return ok(await subirArchivo(u, b));
      if (metodo === 'GET' && path.startsWith('/archivos/')) {
        const a = await bajarArchivo(u, decodeURIComponent(path.slice(10)));
        return { status: 200, headers: { 'Content-Type': a.tipo, 'Cache-Control': 'private, max-age=3600' }, body: a.buffer };
      }
      throw fallo(404, 'Ruta no encontrada.');
    } catch (e) {
      if (e.status) return { status: e.status, headers: { 'Content-Type': 'application/json' }, body: { mensaje: e.mensaje } };
      console.error('granate-nube', metodo, path, e && (e.stack || e.message || e));
      return { status: 500, headers: { 'Content-Type': 'application/json' }, body: { mensaje: 'Error interno del servidor. Intenta de nuevo en un momento.' } };
    }
  }
  const ok = body => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body });
  return { handle, VERSION };
}

module.exports = { crearNucleo, hashClave, claveOk, sha256, normCodigo, ROLES, VERSION };
GRANATE_EOF
mkdir -p "$APIDIR/src"
cat > "$APIDIR/src/almacen.js" <<'GRANATE_EOF'
'use strict';
/* Almacén de Granate nube en Azure: Cosmos DB (datos y cuentas) + Blob Storage (copias PDF). */
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');

const conCodigo = e => { const x = new Error(e?.message || 'cosmos'); x.code = e?.code || e?.statusCode; return x; };

function crearAlmacen(env = process.env) {
  const cosmos = new CosmosClient({ endpoint: env.COSMOS_ENDPOINT, key: env.COSMOS_KEY });
  const db = cosmos.database(env.COSMOS_DB || 'granate');
  const datos = db.container('datos');      // clave de partición /empresa
  const cuentas = db.container('cuentas');  // clave de partición /id
  const conn = env.ARCHIVOS_CONN || env.AzureWebJobsStorage;
  const blobs = conn ? BlobServiceClient.fromConnectionString(conn).getContainerClient(env.ARCHIVOS_CONTENEDOR || 'archivos') : null;
  let blobListo = null;

  async function leer(cont, id, pk) {
    try {
      const r = await cont.item(id, pk).read();
      return r.resource ? { doc: r.resource, etag: r.etag || r.resource._etag } : null;
    } catch (e) { if ((e.code || e.statusCode) === 404) return null; throw e; }
  }
  const consulta = (cont, query, parameters, opts) => cont.items.query({ query, parameters }, opts);

  return {
    async usuario(email) { return (await leer(cuentas, email, email))?.doc || null; },
    async guardarUsuario(u) { await cuentas.items.upsert(u); return u; },
    async usuariosDe(emp) {
      const { resources } = await consulta(cuentas, 'SELECT * FROM c WHERE c.tipo = "usuario" AND c.empresa = @e', [{ name: '@e', value: emp }]).fetchAll();
      return resources;
    },
    async cuenta(id) { return (await leer(cuentas, id, id))?.doc || null; },
    async crearCuenta(doc) { try { const { resource } = await cuentas.items.create(doc); return resource; } catch (e) { throw conCodigo(e); } },
    async guardarCuenta(doc) { const { resource } = await cuentas.items.upsert(doc); return resource; },
    async contador(id) { return leer(cuentas, id, id); },
    async reemplazarContador(doc, etag) {
      try { await cuentas.item(doc.id, doc.id).replace(doc, { accessCondition: { type: 'IfMatch', condition: etag } }); }
      catch (e) { throw conCodigo(e); }
    },
    async guardar(doc) { const { resource } = await datos.items.upsert(doc); return resource; },
    async desde(emp, ts, cont, limite) {
      const it = consulta(datos, 'SELECT * FROM c WHERE c.empresa = @e AND c._ts >= @t ORDER BY c._ts ASC', [{ name: '@e', value: emp }, { name: '@t', value: ts }],
        { partitionKey: emp, maxItemCount: limite, continuationToken: cont || undefined });
      const r = await it.fetchNext();
      return { items: r.resources || [], cont: r.continuationToken || null };
    },
    async maxNumero(emp, tipo, serie) {
      const { resources } = await consulta(datos, 'SELECT VALUE MAX(c.numero) FROM c WHERE c.empresa = @e AND c.col = "documentos" AND c.tipo = @t AND c.serie = @s',
        [{ name: '@e', value: emp }, { name: '@t', value: tipo }, { name: '@s', value: serie }], { partitionKey: emp }).fetchAll();
      return Number(resources && resources[0]) || 0;
    },
    async subirArchivo(ruta, buf, tipo) {
      if (!blobs) throw new Error('Sin almacenamiento de archivos configurado');
      if (!blobListo) blobListo = blobs.createIfNotExists().catch(e => { blobListo = null; throw e; });
      await blobListo;
      await blobs.getBlockBlobClient(ruta).uploadData(buf, { blobHTTPHeaders: { blobContentType: tipo } });
    },
    async bajarArchivo(ruta) {
      if (!blobs) return null;
      try {
        const b = blobs.getBlockBlobClient(ruta);
        const [buf, p] = await Promise.all([b.downloadToBuffer(), b.getProperties()]);
        return { buffer: buf, tipo: p.contentType || 'application/octet-stream' };
      } catch (e) { if (e.statusCode === 404) return null; throw e; }
    },
  };
}

module.exports = { crearAlmacen };
GRANATE_EOF
fi
cd "$APIDIR"
rm -rf node_modules && npm install --omit=dev --no-audit --no-fund --loglevel=error
ZIP="$(mktemp -d)/granate-nube.zip"
zip -qr "$ZIP" . -x '*.git*'
az functionapp deployment source config-zip -g "$RG" -n "$FN" --src "$ZIP" -o none

HOST="$(az resource show -g "$RG" -n "$FN" --resource-type Microsoft.Web/sites --query properties.defaultHostName -o tsv)"
paso "Comprobando la API"
for i in 1 2 3 4 5 6; do
  if OUT="$(curl -fsS "https://$HOST/api/salud" 2>/dev/null)"; then echo "$OUT"; break; fi
  sleep 10
done
printf '\n\033[1;32m✔ Listo\033[0m\n'
echo "URL de la API (va en web/granate-config.js como GRANATE_NUBE):"
echo "  https://$HOST/api"
echo "Cosmos DB: $COS ($MODO) · Región: $R"
if [ -n "$CODIGO" ]; then
  printf '\n\033[1;33mCódigo de instalación (un solo uso, cópialo ahora):  %s\033[0m\n' "$CODIGO"
  echo "Úsalo en la app → «Primera instalación» para crear al administrador."
fi
