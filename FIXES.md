# Correcciones para CESVI

Revisión del commit `5886bce` (rama `main`). Esta carpeta es una copia completa del repo con los bugs corregidos.
El parche equivalente está en `../CESVI-fixes.patch`.

Para aplicarlo en tu repo:

```bash
git checkout -b fix/bugs-revision
git apply CESVI-fixes.patch
pnpm install && pnpm run dev
```

## Bugs corregidos

### Backend (`api/`)

| # | Archivo | Bug | Corrección |
|---|---------|-----|------------|
| 1 | `api/[...path].ts` | Vercel solo admite rutas catch-all `[...x]` en proyectos Next.js. En un proyecto Vite, `/api/cases/EXP-0248/scenes` puede dar 404. | El archivo se renombra a `api/router.ts` y `vercel.json` reescribe `/api/:path*` hacia `/api/router?path=...`. |
| 2 | `api/router.ts` | `Access-Control-Allow-Origin: *` junto con `Allow-Credentials: true` es una combinación que el navegador rechaza, y el cliente usaba `credentials: "include"`. Si la API vive en otro dominio (`VITE_API_BASE_URL`), todas las peticiones fallan. | Se quita `Allow-Credentials` y `credentials: "include"`, porque la API no usa cookies. |
| 3 | `api/_store.ts` | `POST .../scenes` ignoraba `order`: la escena siempre quedaba al final y la respuesta mostraba un `order` distinto al guardado (decía 1 y se guardaba en la posición 4). | La escena se inserta en la posición pedida. |
| 4 | `api/router.ts` | `PATCH /scenes/:id` devolvía el objeto antes de actualizar `updatedAt`. | Nueva función `renameScene` que devuelve la escena ya actualizada. |
| 5 | `api/router.ts` | Una URL con un escape inválido (`%E0`) hacía que `decodeURIComponent` lanzara un error fuera del `try`, lo que daba un 500. | Decodificación segura. |

### Desarrollo local

| # | Archivo | Bug | Corrección |
|---|---------|-----|------------|
| 6 | `vite.config.ts` | `npm run dev` no ejecuta las funciones de `/api`, así que en local todas las llamadas daban 404: no cargaba el expediente y el chat fallaba. | Plugin `localApiRoutes()` (solo en dev) que sirve `api/router.ts` desde Vite. |
| 7 | `.figma/make/site.json` | Faltaban `title` y `language`, así que el sitio salía como "Figma Make App" con `lang="en"`. | Se añaden `"CESVI · Reconstrucción vial"` y `"es"`. |
| 8 | `tsconfig.json` | `lib: ES2020` no incluye `Array.prototype.at`, que `App.tsx` ya usaba, por lo que `tsc` marcaba error. | `lib: ES2022`. |

### Frontend (`src/App.tsx`, `src/lib/api.ts`)

| # | Bug | Corrección |
|---|-----|------------|
| 9 | **Chat:** las respuestas del asistente se mostraban como burbujas del usuario (a la derecha), y aparecía una burbuja vacía mientras llegaba la respuesta. | Los mensajes ahora tienen `role` (`user` / `assistant`) y se muestran con el estilo de cada rol. |
| 10 | Los errores de la API y del chat se guardaban en `dataError` pero nunca se mostraban, así que los fallos pasaban en silencio. | Se muestra un aviso en pantalla. |
| 11 | Las escenas nuevas (botón +) solo existían en el estado local; nunca se llamaba a `api.createScene`. | Se guardan en la API. |
| 12 | Al elegir una sugerencia de ubicación, el menú de sugerencias se volvía a abrir, porque cambiar el texto lanzaba otra búsqueda. En dev (StrictMode) también se buscaba nada más cargar la página. | Se usa un ref con la consulta que no debe buscarse. |
| 13 | Al buscar otra ubicación, solo la escena 01 se movía. Las demás escenas volvían a Reforma (CDMX) y los vehículos se quedaban allí. | Todo el escenario (vehículos, impacto, evidencias y objetos) se traslada a la nueva ubicación, conservando las distancias entre elementos. |
| 14 | `mapViewCenter` se infería como `number[]`, lo que da un error de tipos en `setView` y en `MapViewport`. | Tipado como `[number, number]`. |
| 15 | Si al arrastrar no se encontraba el elemento, el mapa se quedaba sin poder moverse (`dragging.disable()` se llamaba antes del `return`). En pantallas táctiles, `pointercancel` dejaba el mismo problema. | Se deshabilita después de validar el elemento y se maneja `pointercancel`. |
| 16 | Vehículos del catálogo con el ícono equivocado: "Camiones rígidos" y "Trenes de carretera" salían como auto, y "Turismo", "Sport", "Naked", "Custom", "Trail" y "Supermotard" también salían como auto en vez de moto. | Tabla explícita de etiqueta a variante. |
| 17 | `EXP-0248` estaba escrito a mano en el título, el informe y el aviso del chat; `VITE_CASE_ID` no tenía efecto en la interfaz. | Se usa `caseContext.id` o `api.caseId`. |
| 18 | "Exportar informe" podía no descargar el archivo (Firefox exige que el enlace esté en el DOM, y la URL se revocaba antes de que empezara la descarga). | Se agrega el enlace al DOM y la URL se revoca con retraso. |
| 19 | "Nuevo expediente" dejaba los vehículos, el impacto, las evidencias, la ubicación y el chat del caso anterior. | Se reinicia todo. |
| 20 | El indicador de norte siempre volvía al pin de ubicación, aunque estuvieras en otra escena. | Centra la vista actual. |
| 21 | `request()` en `api.ts`: `...init` iba después de `headers`, así que unas cabeceras pasadas por parámetro reemplazaban a las calculadas. | Se aplica `...init` primero. |

## Pendientes (no corregidos, requieren decisión)

- **Persistencia:** `api/_store.ts` guarda los datos en memoria. En Vercel se pierden entre invocaciones o instancias. Hace falta conectarlo a Postgres, Redis o Vercel KV.
- **Funciones sin implementar:** el modo "Medir" no hace nada; el inspector (Nissan Versa, 42 km/h), el progreso (62%), las métricas del dashboard y "Adjuntar evidencia" son datos fijos de maqueta; no hay interfaz para renombrar ni borrar escenas.
- **`src/player-and-light-theme.css`** no se importa en ningún sitio (código muerto).
- **Dos lockfiles** (`package-lock.json` y `pnpm-lock.yaml`). Figma Make y Vercel usan pnpm; conviene borrar `package-lock.json`.
- **Nominatim:** su política de uso limita a 1 petición por segundo. En producción conviene un proxy propio o un proveedor de geocodificación.
- Figma Make puede regenerar `.figma/make/site.json` y `vite.config.ts`; revisa que los cambios se mantengan.

## Integrar un chatbot

El frontend ya está listo. `src/lib/api.ts → sendAssistantMessage` envía:

```json
POST /api/ai/chat
{ "caseId": "EXP-0248", "message": "texto", "stream": true,
  "context": { "case": {...}, "scene": "Impacto", "selectedTool": "...",
               "selectedFrame": 2, "droppedItems": [...], "vehicles": {...} } }
```

y acepta dos formatos de respuesta:
- JSON: `{ "answer": "..." }` o `{ "message": "..." }`
- SSE (`text/event-stream`): líneas `data: {"token":"..."}` (también `content` o `answer`), y al final `data: [DONE]` o `data: {"done":true}`

Solo hay que reemplazar la respuesta simulada en `api/router.ts` (bloque `resource === "ai"`). Hay dos opciones:

**A. El chatbot ya es un servicio HTTP** (Flask, FastAPI, Node, n8n, etc.): CESVI le reenvía la petición.

```ts
if (resource === "ai" && resourceId === "chat" && method === "POST") {
  const body = requestBody(request);
  const message = requiredString(body.message, "message");
  const upstream = await fetch(process.env.CHATBOT_URL!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.CHATBOT_API_KEY ? { Authorization: `Bearer ${process.env.CHATBOT_API_KEY}` } : {}),
    },
    // Adapta los nombres de campos a lo que espere tu chatbot:
    body: JSON.stringify({ message, context: body.context, caseId: body.caseId }),
  });
  if (!upstream.ok) { sendJson(response, 502, { error: "Chatbot no disponible" }); return; }
  const data = (await upstream.json()) as { answer?: string; reply?: string; response?: string };
  const answer = data.answer ?? data.reply ?? data.response ?? "";
  body.stream === true ? writeAssistantStream(response, answer) : sendJson(response, 200, { answer });
  return;
}
```

(El `handler` tiene que pasar a `async function handler(...)`.)

**B. El chatbot es un prompt o lógica sobre un LLM** (OpenAI, Gemini, Claude): llama al proveedor desde `router.ts`. Pon el contenido del bot como system prompt e inyecta `body.context` como datos del caso. Si quieres respuesta en vivo, reenvía el streaming del proveedor con el formato `data: {"token": ...}`.

En los dos casos, las claves van en variables de entorno de Vercel (`CHATBOT_URL`, `CHATBOT_API_KEY`, `OPENAI_API_KEY`...), nunca en `src/`: todo lo que está en `src/` y en `VITE_*` llega al navegador.
