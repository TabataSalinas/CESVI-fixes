# CESVI — Sistema de Reconstrucción Pericial y Simulación Vial

> **Entrevista con el modelo de Ollama y link para compartir:** ver [`chatbot-service/README.md`](chatbot-service/README.md). Inicio rápido en Windows: doble clic en `iniciar-cesvi.bat`.

Plataforma integral para el peritaje y reconstrucción de hechos de tránsito terrestre. Combina un frontend modular interactivo con captura cartográfica geo-referenciada, un motor de entrevista pericial determinista y un servicio de extracción estructurada asistida por Inteligencia Artificial (Groq / Google Gemini).

---

## 1. Arquitectura del Proyecto

El sistema está diseñado bajo una arquitectura desacoplada y modular:

```
CESVI/
├── src/                                  # Frontend modular en React 19 + Vite + TypeScript
│   ├── App.tsx                           # Contenedor orquestador de alto nivel
│   ├── components/
│   │   ├── assistant/                    # Chatbot y panel de asistencia pericial
│   │   ├── catalog/                      # Catálogo desplegable de objetos, indicios y vehículos
│   │   ├── common/                       # Aislamiento de fallas (ErrorBoundary)
│   │   ├── dashboard/                    # Centro de expedientes y métricas
│   │   ├── layout/                       # Barra superior y navegación de la app
│   │   ├── map/                          # Lienzo de Leaflet, capas de vehículos e inspector
│   │   ├── ribbon/                       # Cinta de herramientas y búsqueda de ubicaciones
│   │   ├── timeline/                     # Pestañas de escenas y barra de reproducción
│   │   └── ui/                           # Componentes visuales base (Button, Icon, VehicleSprite)
│   ├── hooks/                            # Hooks desacoplados (useLocationSearch, useScenarioItems, ...)
│   ├── lib/                              # Clientes API y utilidades
│   └── types/                            # Contratos y tipos TypeScript (api.ts, scenario.ts)
│
├── backend/                              # Backend en FastAPI + SQLAlchemy + SQLite
│   ├── app/
│   │   ├── config.py                     # Configuración y variables de entorno Pydantic
│   │   ├── database.py                   # Conexión SQLAlchemy y sesiones SQLite
│   │   ├── models.py                     # Modelos ORM (Case, Document, Interview, Extraction...)
│   │   ├── routers/                      # Rutas REST (/assistant, /cases, /documents, /interview)
│   │   └── services/
│   │       ├── llm.py                    # Cliente LLM con soporte Groq y respaldo Gemini
│   │       └── interview/                # Motor de la entrevista pericial
│   │           ├── engine.py             # Generación determinista de preguntas + delegación de extracción
│   │           ├── schema.py             # Catálogo de temas y modalidades de impacto (intacto)
│   │           ├── chat_core.py          # Lógica de verificación y actualización de hechos (intacto)
│   │           └── facts_utils.py        # Normalización y contrastación de citas y unidades
│   └── tests/                            # Pruebas unitarias sin red (pytest)
```

### Principios de Arquitectura

1. **Frontend Modular y Resiliente:**
   - `src/App.tsx` actúa únicamente como orquestador de estado de alto nivel.
   - Cada sección funcional (`TopBar`, `RibbonBar`, `MapCanvas`, `Timeline`, `AssistantPanel`, `Dashboard`) está encapsulada en un `ErrorBoundary`, impidiendo que un error visual o de renderizado en un módulo rompa el resto de la aplicación.
   - La lógica reactiva compleja vive en hooks dedicados (`useLocationSearch`, `useScenarioItems`, `useTimelinePlayback`, `useAssistantChat`).

2. **Backend Determinista y Seguro:**
   - **Preguntas Deterministas:** `engine.py` utiliza plantillas de preguntas parametrizadas por vehículo (ej. `"¿Qué maniobra realizó {vehículo} antes del impacto?"`) y el orden canónico de prioridades, eliminando la necesidad de un modelo local para decidir qué preguntar.
   - **Extracción Delegada a la Nube:** La extracción de respuestas complejas se delega a `llm_client` en `backend/app/services/llm.py`, utilizando Groq como proveedor principal y Gemini como respaldo.
   - **Seguridad de Credenciales:** Las API keys (`GROQ_API_KEY`, `GEMINI_API_KEY`) residen exclusivamente del lado servidor en `backend/.env`.
   - **Persistencia Confiable:** Todo el progreso de la entrevista se almacena en la tabla relacional `interviews` asociada al expediente (`case_id`).

---

## 2. Requisitos Previos

- **Node.js**: v20 o superior.
- **pnpm**: v10 o superior.
- **Python**: v3.12 o v3.13 con `pip` y soporte de `venv`.

---

## 3. Manual de Instrucciones y Uso para Desarrolladores

### 3.1 Configuración de Variables de Entorno

#### Backend (`backend/.env`):
Crea el archivo `backend/.env` (puedes tomar como base `backend/.env.example` si existe) con la configuración deseada:

```env
# Proveedores de IA (solo en servidor)
GROQ_API_KEY=tu_clave_de_groq_aqui
GROQ_MODEL=llama-3.3-70b-versatile

GEMINI_API_KEY=tu_clave_de_gemini_aqui
GEMINI_MODEL=gemini-1.5-flash

# Base de datos y servidor
DATABASE_URL=sqlite:///./cesvi.db
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8443,http://localhost:3000
PORT=8000
```

> **Nota:** Puedes configurar ambas claves, solo una de ellas, o ninguna en modo pruebas offline (el motor utilizará guardas y fallbacks seguros si no hay red o credenciales).

#### Frontend (`.env` o `.env.local` en la raíz):
```env
VITE_API_URL=http://localhost:8000
VITE_CASE_ID=EXP-0248
```

---

### 3.2 Puesta en Marcha del Backend (FastAPI)

1. Ingresar a la carpeta `backend`:
   ```bash
   cd backend
   ```

2. Crear y activar el entorno virtual:
   - **En Windows (PowerShell):**
     ```powershell
     python -m venv .venv
     .venv\Scripts\Activate.ps1
     ```
   - **En Linux / macOS:**
     ```bash
     python3 -m venv .venv
     source .venv/bin/activate
     ```

3. Instalar dependencias:
   ```bash
   pip install -r requirements.txt
   ```

4. Iniciar el servidor de desarrollo:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```
   El backend estará disponible en `http://localhost:8000` (con documentación interactiva Swagger en `http://localhost:8000/docs`).

---

### 3.3 Puesta en Marcha del Frontend (React + Vite)

Desde la raíz del repositorio:

1. Instalar dependencias:
   ```bash
   pnpm install
   ```

2. Iniciar el servidor de desarrollo Vite:
   ```bash
   pnpm dev
   ```
   La aplicación se abrirá en `http://localhost:5173` o el puerto configurado.

---

## 4. Validación y Ejecución de Pruebas

### 4.1 Verificación Estática del Frontend
```bash
# Verificación de tipos estáticos TypeScript
pnpm typecheck

# Compilación de producción
pnpm build
```

### 4.2 Pruebas Unitarias del Backend (sin red)
Con el entorno virtual activado en `backend/`:
```bash
cd backend
pytest -v
```
Las pruebas de la entrevista (`backend/tests/test_interview.py`) validan:
- Generación correcta de plantillas por vehículo.
- Determinismo de selección de preguntas según prioridad.
- Extracción offline segura ante saltos de preguntas.
- Transiciones de estado hasta la finalización de la entrevista.

---

## 5. Créditos y Atribuciones

Este proyecto utiliza componentes y datos de cartografía libre:

- **Datos cartográficos:** &copy; [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- **Geocodificación y búsqueda de direcciones:** [Nominatim](https://nominatim.openstreetmap.org/) bajo licencia ODbL (Open Database License).
- **Lienzo cartográfico:** [Leaflet](https://leafletjs.com/) y [React-Leaflet](https://react-leaflet.js.org/).

