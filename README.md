# Granate · Cotiza y Factura

| Carpeta | Qué es |
|---|---|
| `web/granate.html` | La aplicación (un solo archivo). Publícala en tu dominio (Azure Static Web Apps, Netlify…). |
| `api/` | API Node: envía comprobantes a SUNAT (beta o producción) y sirve el **padrón RUC** para autocompletar clientes. |
| `padron/build_padron.py` | Convierte el padrón reducido de SUNAT en una base SQLite con búsqueda por RUC, DNI y razón social. |
| `.github/workflows/padron-sunat.yml` | **Robot diario**: descarga el padrón de SUNAT, arma la base y la publica como Release. |

## Cómo fluye el padrón

```
SUNAT (padron_reducido_ruc.zip, ~395 MB, diario)
   │  03:37 Lima · GitHub Actions
   ▼
Robot: valida formato → padron.db (SQLite + FTS5) → padron.db.gz (~305 MB) → Release "padron-AAAAMMDD"
   │  cada 6 h
   ▼
API Granate: descarga la última versión, la valida y la reemplaza sin cortar el servicio
   │
   ▼
Web: al escribir un RUC, DNI o razón social completa nombre, dirección, distrito y estado (ACTIVO · HABIDO)
```

Medido con el padrón del 07/11/2026: **13,9 millones de contribuyentes** activos o suspendidos (de 18,5 millones),
**960 mil empresas** buscables por nombre, base de 711 MB, consulta por RUC en ~1 ms.

## Puesta en marcha

1. Crea un repositorio **privado** con estas carpetas (el padrón incluye RUC de personas naturales, que contienen el DNI).
2. En GitHub: *Actions → Padrón SUNAT diario → Run workflow* para la primera carga (~10 minutos).
3. Crea un token *fine-grained* de solo lectura (Contents: Read) para ese repo.
4. API: `cd api && npm install && cp .env.example .env` (llena `PADRON_REPO` y `PADRON_GITHUB_TOKEN`) y `npm start`.
   Al arrancar descarga el padrón (~305 MB) y luego revisa cada 6 h.
5. Web: *Integración SUNAT → Tu API Granate → URL* → *Probar conexión*. Debe decir «Padrón RUC de SUNAT conectado».

## Endpoints

| Ruta | Respuesta |
|---|---|
| `GET /padron/ruc/{ruc o dni}` | `{ ruc, razonSocial, estado, condicion, direccion, distrito, provincia, departamento, direccionCompleta, apto }` — 404 si no figura activo |
| `GET /padron/buscar?q=texto` | `{ datos: [...] }` empresas (RUC 20) por razón social |
| `GET /padron/estado` | fecha de la versión de SUNAT, registros, empresas |
| `POST /cpe/emitir` | ver `api/README` del conector SUNAT |

## Notas

- Si SUNAT no cambió el archivo, el robot no reconstruye (compara `Last-Modified`). Para forzar: *Run workflow → forzar*.
- Si SUNAT cambia el formato del padrón, el robot falla a propósito y no publica una base dañada.
- Persona natural: se busca por RUC o DNI (no por nombre). Las empresas, por razón social.
- Protege la API (Entra ID, API Management o una clave) antes de exponerla en internet.
- Azure: App Service Linux (Node 22.13+) con `PADRON_DB=/home/data/padron.db`, o Container Apps con volumen.
