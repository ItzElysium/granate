# Granate API · conector SUNAT

Puente entre la web **Granate · Cotiza y Factura** y SUNAT (SEE del contribuyente).
Recibe el comprobante desde la web, **firma el XML UBL 2.1** (XMLDSig), lo **comprime en ZIP**,
lo envía con **sendBill** y devuelve la **Constancia de Recepción (CDR)**.

## 1. Probar en el beta de SUNAT (5 minutos)

El beta oficial no exige certificado registrado: usa el usuario `[RUC]MODDATOS` y la clave `MODDATOS`.
La API genera sola un certificado autofirmado para beta.

```bash
npm install
npm run prueba:beta     # envía factura, boleta y nota de crédito al beta de SUNAT
npm start               # levanta la API en http://localhost:7071
```

Respuesta esperada: `ACEPTADO 0 | La Factura numero F001-1, ha sido aceptada`.

> En beta varias empresas comparten el RUC de prueba 20000000001. Para pruebas propias usa tu RUC real
> con `MODDATOS`: nada de lo emitido en beta tiene validez tributaria.

## 2. Conectar la web

1. Publica `granate.html` en tu dominio (Azure Static Web Apps, Netlify, un bucket estático…).
   Dentro de claude.ai la web no puede llamar a otros dominios; por eso usa el simulador ahí.
2. En la web: **Integración SUNAT → API propia → URL base** (p. ej. `https://api.tuempresa.pe`) → *Probar conexión*.
3. Emite: la web muestra el CDR real y permite descargarlo (`CDR SUNAT`).

## 3. Contrato

| Método | Ruta | Uso |
|---|---|---|
| GET | `/health` | `{ ok, ambiente }` |
| POST | `/cpe/emitir` | `{ ambiente, emisor:{ruc}, documento:{tipo,serie,numero,…}, xml }` → `{ estado, codigo, descripcion, observaciones, hash, cdrZipBase64 }` |
| GET | `/padron/ruc/:ruc` | Responde 501: conecta aquí tu proveedor de consulta RUC |

`estado`: `ACEPTADO` · `OBSERVADO` · `RECHAZADO` (2000–3999, emite uno nuevo) · `ERROR` (0100–1999, corrige y reenvía con el mismo número).

## 4. Pasar a producción

- [ ] Certificado digital (por ejemplo, el Certificado Digital Tributario de SUNAT) en `.pfx` → `CERT_PFX_PATH` / `CERT_PFX_PASSWORD`
- [ ] Usuario SOL secundario con perfil de emisión → `SUNAT_USUARIO_SOL` / `SUNAT_CLAVE_SOL`
- [ ] `SUNAT_AMBIENTE=produccion`, `SUNAT_RUC`, `ALLOW_ORIGIN` con tu dominio
- [ ] Secretos en Azure Key Vault o variables protegidas, nunca en la web
- [ ] Autenticación delante de la API (Entra ID / API Management / API key)
- [ ] Despliegue: Azure App Service (Node 20+) o Container Apps con `npm start`

## 5. Pendiente para una v2

- Resumen diario y comunicación de baja (`sendSummary` + `getStatus` por ticket)
- Recuperar CDR de comprobantes ya enviados (`billConsultService`)
- Consulta de validez (API REST OAuth2) y padrón RUC
- Adaptador para OSE: si el OSE expone el mismo servicio SOAP, basta cambiar `endpoint` y credenciales en `sunat.js`; si usa API REST propia, se agrega un adaptador.
