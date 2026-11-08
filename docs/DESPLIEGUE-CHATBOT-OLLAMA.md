# Desplegar el chatbot de entrevista (Ollama) como aplicación propia

Guía para el equipo que recibe el proyecto. Rama: `temporal`.

## Qué es y qué necesita

```
Navegador ──► chatbot-service/server.py (:8787) ──► Ollama (:11434) ──► modelo "cesvi"
              (sirve la web dist/ + la API /api)
```

- **No hay API keys.** Ollama no pide clave. No hace falta un `.env` para que funcione.
- Un solo programa (`server.py`) sirve la web compilada y la API, en un solo puerto.
- Variables opcionales: ver [`chatbot-service/.env.example`](../chatbot-service/.env.example).

## Qué NO está en GitHub (hay que recibirlo aparte)

- **`cesvi-q4_k_m.gguf`** (~2.5 GB). Va en la raíz del proyecto, junto a `Modelfile`.
  `.gitignore` lo excluye. Pídelo a quien entrenó el modelo (Drive, USB, etc.).

## Requisitos de la máquina

- Ollama (https://ollama.com/download)
- Python 3.8+ (no necesita paquetes con pip)
- Node.js 22 (solo para compilar la web)
- RAM suficiente para el modelo (el archivo pesa ~2.5 GB; deja margen para el sistema)

## Pasos

```bash
git clone https://github.com/TabataSalinas/CESVI-fixes.git
cd CESVI-fixes
git checkout temporal

# 1. Copia cesvi-q4_k_m.gguf a esta carpeta (junto a Modelfile)

# 2. Crear el modelo en Ollama (una sola vez)
ollama create cesvi -f Modelfile

# 3. Compilar la web
npm install
npm run build

# 4. Arrancar
python3 chatbot-service/server.py        # en Windows: py chatbot-service\server.py
```

Abre `http://127.0.0.1:8787`. En Windows se puede usar `iniciar-cesvi.ps1`, que hace todo lo anterior y crea un link público temporal con Cloudflare.

## Cambiar la configuración

`server.py` lee variables de entorno (no carga un archivo `.env`). Ejemplos:

```bash
# Linux / macOS
export OLLAMA_URL=http://otro-equipo:11434
export CHATBOT_PORT=9000
python3 chatbot-service/server.py
```

```powershell
# Windows PowerShell
$env:OLLAMA_URL = "http://otro-equipo:11434"
$env:CHATBOT_PORT = "9000"
py chatbot-service\server.py
```

## Notas de seguridad

- **El servidor no tiene login.** Quien llegue a la URL usa el modelo. Ponlo detrás de un proxy con autenticación (nginx, Cloudflare Access, etc.) si lo expones.
- Por defecto escucha solo en `127.0.0.1`. Usa `CHATBOT_HOST=0.0.0.0` solo si sabes qué haces.
- Todos los usuarios comparten el mismo expediente (`EXP-0248`) y la misma entrevista.
- El modelo atiende una pregunta a la vez.
- No subas claves ni `.env` reales a Git.

## Qué NO funciona en Vercel

Vercel solo ejecuta funciones sin estado y no puede correr Ollama. En Vercel funcionan la web y el chat libre (con `GEMINI_API_KEY` o `GROQ_API_KEY`), pero **no la pestaña "Entrevista IA"** con este modelo. Para una app propia hace falta un servidor (VPS o equipo propio) con Ollama.

## Carpetas que no forman parte del chatbot

- `backend/`, `engine.py`, `interview.py`: otra versión de la entrevista (FastAPI, con su propio `INTERVIEW_API_KEY`).
- `api/` y `server/`: chat libre para Vercel (Gemini/Groq).
- `CESVI-llm-main/`: material de entrenamiento.
