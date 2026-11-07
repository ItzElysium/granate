# Granate API · SUNAT + base de transacciones

Puente entre la web **Granate · Cotiza y Factura**, SUNAT y tu registro de transacciones.

- **Comprobantes** (factura 01, boleta 03, nota de crédito 07, nota de débito 08): firma el XML UBL 2.1, lo comprime y lo envía por `sendBill`; devuelve la constancia (CDR).
- **Guía de remisión remitente** (09): firma el `DespatchAdvice`, pide token OAuth2 y la envía por la **API REST de GRE**; consulta el ticket hasta tener la constancia. SUNAT **no tiene ambiente beta** para guías: se prueban con el simulador de la web o directamente en producción.
- **Base de transacciones** (`data/granate.db`, SQLite): documentos, cada intento de envío con su XML firmado y CDR, bitácora de la app, copias PDF y control de correlativos.
- **Padrón RUC** para autocompletar clientes (lo publica el robot de GitHub).

## 1. Probar en el beta de SUNAT (5 minutos)

```bash
npm install
npm run prueba:beta     # factura con detracción, factura de bienes con guía, ND y NC al beta de SUNAT
npm start               # API en http://localhost:7071
```

El beta acepta el usuario `[RUC]MODDATOS` / `MODDATOS` y un certificado autofirmado (la API lo genera).

## 2. Conectar la web

1. Publica `web/granate.html` en tu dominio (dentro de claude.ai la web no puede llamar a otros dominios).
2. *Integración SUNAT → Tu API Granate → URL* (y la clave si definiste `GRANATE_API_KEY`) → *Probar conexión*.
3. Elige *API propia → SUNAT real* y el ambiente.

## 3. Contrato

| Método | Ruta | Uso |
|---|---|---|
| GET | `/health` | ambiente, padrón, tamaño de la base, si las guías tienen credenciales |
| POST | `/cpe/emitir` | `{ ambiente, emisor:{ruc}, documento, xml }` → `{ estado, codigo, descripcion, hash, cdrZipBase64, clave }` |
| POST | `/gre/emitir` | igual, para la guía (09). Si SUNAT sigue procesando: `estado: EN_PROCESO` + `ticket` |
| GET | `/gre/ticket/{ruc-09-serie-numero}` | vuelve a consultar una guía en proceso (nunca la reenvía con otro número) |
| POST · GET | `/bitacora` | registra o lista movimientos (`?desde=AAAA-MM-DD&hasta=&evento=sunat.*&limite=`) |
| POST | `/archivo` | guarda la copia PDF `{ docId, tipo, serie, numero, version, nombre, pdfBase64 }` → `{ id }` |
| GET | `/archivo/{id}/pdf` | descarga la copia |
| GET | `/documentos/{ruc-tipo-serie-numero}` | ficha: estado, intentos de envío y copias PDF; `/xml` y `/cdr` descargan los archivos de SUNAT |
| GET | `/correlativos` | por serie: emitidos, último número, saltos y pendientes |
| GET | `/padron/ruc/{ruc o dni}` · `/padron/buscar?q=` · `/padron/estado` | padrón RUC |

`estado`: `ACEPTADO` · `OBSERVADO` · `RECHAZADO` (2000–3999: emite uno nuevo) · `ERROR` (0100–1999: corrige y reenvía con el mismo número).

## 4. Pasar a producción

- [ ] Certificado digital `.pfx` → `CERT_PFX_PATH` / `CERT_PFX_PASSWORD`
- [ ] Usuario SOL secundario con perfil de emisión → `SUNAT_USUARIO_SOL` / `SUNAT_CLAVE_SOL`
- [ ] Guías: en SOL crea las **Credenciales de API SUNAT** → `SUNAT_GRE_CLIENT_ID` / `SUNAT_GRE_CLIENT_SECRET`
- [ ] `SUNAT_AMBIENTE=produccion`, `SUNAT_RUC`, `ALLOW_ORIGIN` con tu dominio, `GRANATE_API_KEY`
- [ ] `GRANATE_DB` en un disco persistente con respaldo diario (contiene XML, CDR y PDF: consérvalos al menos 5 años)
- [ ] Secretos en Azure Key Vault o variables protegidas, nunca en la web
- [ ] Azure App Service Linux (Node 22.13+) o Container Apps con volumen
