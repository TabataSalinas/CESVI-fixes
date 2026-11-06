# CESVI con tu modelo de Ollama y un link para compartir

```
Quien abre el link ──► Cloudflare (link público https://….trycloudflare.com)
                              │  túnel seguro
                              ▼
                   Tu PC ── chatbot-service/server.py (:8787)
                              ├─ sirve la web (carpeta dist/)
                              ├─ /api/ai/interview/*  ──► Ollama (:11434) ──► cesvi-q4_k_m.gguf
                              └─ /api/cases/*  (escenas del expediente, en memoria)
```

- **Un solo programa y un solo puerto:** `server.py` sirve la web y la API, así que basta **un** túnel para compartirlo todo.
- **Tu modelo recibe los mismos prompts con los que se entrenó:** `chatbot-service/schema.py` es tu `schema.py` de entrenamiento, sin cambios. (El `backend/` de esta rama usa una versión modificada con otros textos y prioridades.)
- **Sin claves de API ni nube:** no usa Groq ni Gemini. No hay nada que instalar con pip.
- En la web, el panel derecho tiene dos pestañas: **Reconstrucción** (el asistente paso a paso de siempre) y **Entrevista IA** (tu modelo).

## Importante antes de compartir

- El link **solo funciona mientras tu PC esté encendida** y la ventana del script siga abierta. Si apagas la PC, quien tenga el link verá un error.
- El link **cambia cada vez** que vuelves a ejecutar el script (son links gratuitos de prueba de Cloudflare). Para un link fijo, mira "Link fijo" más abajo.
- **Cualquiera con el link usa tu PC y tu modelo.** Compártelo solo con quien quieras. Todos los que abran el link comparten el mismo expediente (EXP-0248) y la misma entrevista.
- El modelo atiende **una pregunta a la vez**. Si varias personas lo usan juntas, esperan su turno.

## Requisitos (una sola vez)

1. **Ollama:** https://ollama.com/download. Ábrelo una vez.
2. **Python 3.8+:** https://www.python.org/downloads/ (marca *Add python.exe to PATH* al instalar).
3. **Node.js 22:** https://nodejs.org
4. **cloudflared** (para el link público). En PowerShell:
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
   Cierra y vuelve a abrir PowerShell después de instalarlo.
5. Copia **`cesvi-q4_k_m.gguf`** a la carpeta del proyecto, junto a `Modelfile`. (Está en `.gitignore`: no se sube a Git.)

## Uso

### Opción fácil: doble clic
Haz doble clic en **`iniciar-cesvi.bat`** (en la carpeta del proyecto). El script:

1. Comprueba Ollama y crea el modelo `cesvi` si todavía no existe.
2. Compila la web la primera vez (`npm install` y `npm run build`).
3. Carga el modelo en memoria.
4. Arranca el servidor y crea el link público.
5. Muestra el link en verde, lo copia al portapapeles y lo abre en el navegador.

**Deja esa ventana abierta.** Para detener todo, presiona `Ctrl + C` en ella.

### Opciones del script (desde PowerShell, en la carpeta del proyecto)
```powershell
.\iniciar-cesvi.ps1               # link público
.\iniciar-cesvi.ps1 -SoloLocal    # sin link público: solo http://127.0.0.1:8787
.\iniciar-cesvi.ps1 -Recompilar   # vuelve a compilar la web (hazlo después de git pull)
```

### Opción manual (si el script falla)
```powershell
ollama create cesvi -f Modelfile      # solo la primera vez
npm install                           # solo la primera vez
npm run build                         # cada vez que cambie el código
py chatbot-service\server.py          # ventana 1: déjala abierta
cloudflared tunnel --url http://127.0.0.1:8787   # ventana 2: busca el link https://….trycloudflare.com
```
Usa `127.0.0.1` y no `localhost` en el comando de cloudflared. En Windows, `localhost` puede resolverse a otra dirección y el túnel no encuentra el servidor.

### Para desarrollar (con recarga automática)
```powershell
py chatbot-service\server.py    # ventana 1
npm run dev                     # ventana 2 → http://localhost:8443  (Vite reenvía /api al puerto 8787)
```

## Cómo se usa la entrevista

1. Abre la pestaña **Entrevista IA** en el panel derecho.
2. Elige la **modalidad** del siniestro. Los vehículos se proponen solos si ya los registraste en la Escena 02; puedes corregirlos.
3. Pulsa **Iniciar entrevista** y responde cada pregunta. Escribe `saltar` para omitir un tema.
4. Al terminar, **Exportar informe** genera el PDF con una página adicional: "7. Entrevista pericial", con todas las respuestas.
5. Para empezar de cero, usa el botón de limpiar del encabezado del panel mientras estás en la pestaña Entrevista IA.

## Problemas frecuentes

| Síntoma | Solución |
|---|---|
| "El asistente de Ollama no está disponible" | Abre la app de Ollama y pulsa **Reintentar**. |
| "Falta el modelo" | `ollama create cesvi -f Modelfile` (el `.gguf` debe estar junto al `Modelfile`). |
| La página dice "Falta compilar la web" | `npm run build`, o ejecuta el script con `-Recompilar`. |
| Error **524** al usar el link | La respuesta tardó más de ~100 s (límite de Cloudflare). Suele pasar si el modelo se descargó de memoria; vuelve a enviar la respuesta. |
| Cambié el código y no veo los cambios en el link | Ejecuta el script con `-Recompilar`: el link sirve la web compilada, no la de `npm run dev`. |
| El link dejó de funcionar | Tu PC se apagó o se cerró la ventana. Vuelve a ejecutar el script: el link será otro. |
| "No pude obtener el link público" | Revisa tu internet y el archivo `%TEMP%\cesvi-cloudflared.log`. |
| El puerto 8787 está ocupado | `.\iniciar-cesvi.ps1 -Puerto 8790` |

## Link fijo (opcional)

Si quieres que el link no cambie, usa ngrok, que da un dominio fijo gratuito por cuenta:

1. Crea una cuenta en https://ngrok.com e instálalo (`winget install ngrok.ngrok`).
2. `ngrok config add-authtoken TU_TOKEN`
3. En el panel de ngrok, en *Domains*, copia tu dominio gratuito.
4. Con el servidor corriendo (`.\iniciar-cesvi.ps1 -SoloLocal`), en otra ventana:
   ```powershell
   ngrok http --url=TU-DOMINIO.ngrok-free.app 8787
   ```

Sigue dependiendo de que tu PC esté encendida. Para un link que funcione siempre hace falta un servidor en la nube que corra el modelo.

## Configuración (variables de entorno, opcionales)

| Variable | Por defecto | Para qué |
|---|---|---|
| `OLLAMA_MODEL` | `cesvi` | Nombre del modelo en Ollama |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Dónde está Ollama |
| `OLLAMA_TIMEOUT` | `300` | Segundos de espera por respuesta del modelo |
| `OLLAMA_KEEP_ALIVE` | `60m` | Tiempo que el modelo queda en memoria sin uso |
| `CHATBOT_PORT` | `8787` | Puerto del servidor |
| `CHATBOT_DATA` | `chatbot-service/sessions.json` | Archivo donde se guardan las entrevistas |
| `CESVI_DIST` | `dist/` | Carpeta de la web compilada |
