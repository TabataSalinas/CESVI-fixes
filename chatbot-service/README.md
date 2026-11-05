# Chatbot local de CESVI (Ollama)

La web de CESVI habla con tu modelo así:

```
Navegador ──► npm run dev (Vite, :8443) ──► chatbot-service (Python, :8787) ──► Ollama (:11434) ──► cesvi-q4_k_m.gguf
              api/router.ts                   server.py + schema.py
```

- **`schema.py`** (raíz del repo, sin modificar) define las modalidades, los temas y los prompts. El servicio lo importa tal cual, así el modelo recibe exactamente los mismos prompts con los que se entrenó.
- **`server.py`** hace lo mismo que `chat_cli.py` pero como API: el código lleva el checklist y el % de avance; el modelo redacta cada pregunta y extrae el valor de cada respuesta.
- **No hay nada que instalar con pip**: solo usa la biblioteca estándar de Python.

## Requisitos

- [Ollama](https://ollama.com/download)
- Python 3.8 o superior (`python --version`; en Mac/Linux puede ser `python3`)
- Node.js 22 (ya lo usas para la web)
- Unos 4 GB de RAM libres para el modelo

## Paso a paso

### 1. Instala Ollama
Descárgalo de https://ollama.com/download e instálalo. Ábrelo una vez para que quede corriendo en segundo plano.

### 2. Coloca el modelo junto al `Modelfile`
Copia tu archivo **`cesvi-q4_k_m.gguf`** a la **raíz del repositorio** (la misma carpeta donde está `Modelfile`). El nombre debe ser exactamente el que dice la primera línea del `Modelfile`.

> El `.gguf` está en `.gitignore`: no se sube a Git aunque hagas `git add .`.

### 3. Crea el modelo en Ollama
Desde la raíz del repositorio:

```bash
ollama create cesvi -f Modelfile
ollama list            # debe aparecer "cesvi"
```

Prueba rápida (opcional): `ollama run cesvi "hola"`. Para salir, escribe `/bye`.

### 4. Arranca el servicio del chatbot (terminal 1)

```bash
python chatbot-service/server.py        # Mac/Linux: python3 ...   Windows: py chatbot-service\server.py
```

Debe imprimir `Servicio CESVI del chatbot en http://127.0.0.1:8787`. **Deja esa terminal abierta.**

Comprueba que ve a Ollama abriendo http://127.0.0.1:8787/health: debe decir `"available": true`.

### 5. Arranca la web (terminal 2)

```bash
npm install     # solo la primera vez
npm run dev
```

### 6. Úsalo
1. Abre http://localhost:8443.
2. En el panel **Asistente pericial** aparece **Iniciar entrevista pericial**.
3. Elige la modalidad, describe el vehículo V1 (y V2 si aplica) y pulsa **Iniciar entrevista**.
4. Responde cada pregunta. Escribe `saltar` para omitir un tema.
5. La barra de **Progreso del expediente** avanza con cada tema. Al llegar a 100% la entrevista termina.
6. **Exportar informe** incluye las respuestas de la entrevista.

La primera pregunta tarda más porque Ollama carga el modelo en memoria. Las siguientes son más rápidas.

Si algo no está activo, el panel lo indica y la web sigue funcionando con el asistente simulado.

## Configuración (variables de entorno, opcionales)

| Variable | Por defecto | Para qué |
|---|---|---|
| `OLLAMA_MODEL` | `cesvi` | Nombre del modelo en Ollama |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Dónde está Ollama |
| `OLLAMA_TIMEOUT` | `300` | Segundos de espera por respuesta |
| `CHATBOT_PORT` | `8787` | Puerto de este servicio |
| `CHATBOT_URL` | `http://127.0.0.1:8787` | (lado de la web) dónde está este servicio |
| `CHATBOT_DATA` | `chatbot-service/sessions.json` | Archivo donde se guardan las entrevistas |

Ejemplo: `OLLAMA_MODEL=otro-nombre python chatbot-service/server.py`

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| El panel dice "El servicio local del chatbot no está activo" | Falta el paso 4. Arranca `server.py`. |
| "Ollama no está activo" | Abre la app de Ollama o ejecuta `ollama serve`. |
| "Falta el modelo" | Falta el paso 3: `ollama create cesvi -f Modelfile`. |
| `ollama create` dice que no encuentra el archivo | El `.gguf` no está en la misma carpeta que el `Modelfile`, o se llama distinto. |
| "No pude estructurar la respuesta; se guardó el texto tal cual" | El modelo no devolvió un JSON válido; el dato se guarda como texto. No es grave. |
| Responde muy lento | Normal sin GPU. Cierra otros programas pesados. |
| El puerto 8787 está ocupado | `CHATBOT_PORT=8788 python chatbot-service/server.py` y arranca la web con `CHATBOT_URL=http://127.0.0.1:8788 npm run dev`. |

## Límites actuales

- Las entrevistas se guardan en `chatbot-service/sessions.json` en tu computadora (no en una base de datos). Para reiniciar una, usa **⋯ → Reiniciar entrevista**.
- Esto funciona **solo en local**. Una web desplegada en Vercel no puede llegar al Ollama de tu computadora; para eso haría falta un servidor propio y apuntar `CHATBOT_URL` hacia él.
