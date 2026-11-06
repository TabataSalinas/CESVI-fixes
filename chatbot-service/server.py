"""Servidor de CESVI con el asistente pericial de Ollama.

Un solo programa hace todo:
  1. Sirve la web ya compilada (carpeta dist/, generada con `npm run build`).
  2. Expone la entrevista pericial en /api/ai/interview/* usando tu modelo de Ollama.
  3. Responde las rutas de expediente que la web pide al cargar (/api/cases/...).

Como todo sale por un único puerto (8787), basta UN túnel (cloudflared o ngrok)
para compartir la aplicación con un link público.

El CÓDIGO lleva el checklist y el % de avance; el MODELO solo redacta cada
pregunta y extrae el valor de cada respuesta, con los mismos prompts con los que
se entrenó (schema.py de esta carpeta, sin modificar).

Solo usa la biblioteca estándar de Python: no hay nada que instalar con pip.

Uso:  python chatbot-service/server.py
"""
import json
import mimetypes
import re
import unicodedata
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import schema  # noqa: E402  (schema.py de entrenamiento, junto a este archivo)

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "cesvi")
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "300"))  # la 1ª carga del modelo puede tardar
# Cuánto tiempo mantiene Ollama el modelo en memoria sin uso. Si se descarga, la siguiente
# pregunta vuelve a cargarlo y puede superar el límite de ~100 s del túnel de Cloudflare.
OLLAMA_KEEP_ALIVE = os.environ.get("OLLAMA_KEEP_ALIVE", "60m")
HOST = os.environ.get("CHATBOT_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHATBOT_PORT", "8787"))
DATA_FILE = Path(os.environ.get("CHATBOT_DATA", ROOT / "sessions.json"))
DIST_DIR = Path(os.environ.get("CESVI_DIST", ROOT.parent / "dist")).resolve()
MAX_BODY_BYTES = 64 * 1024  # el servicio queda expuesto por el túnel: limitar el tamaño de cada petición

# Respuestas que significan "el perito no tiene esa información". Se comparan sin acentos ni
# mayúsculas. Cuidado: "no se encontraron huellas" o "no hubo frenado" SÍ son hechos, por eso
# "no se" solo cuenta si termina ahí ("no sé.", "no sé, ...").
_NO_INFO = re.compile(
    r"^\s*(?:"
    r"saltar|omitir|siguiente|paso|ninguna?|nada|n/?a|ni idea|desconocido|"
    r"no se(?: sabe| nada| tiene)?|no lo se|no sabria(?: decir)?|no sabemos|no sabe|"
    r"no lo sabe|desconozco|lo desconozco|se desconoce|no tengo idea|"
    r"no (?:tengo|tenemos|hay|existe|cuento con|se tiene|se cuenta con)(?: esa| ese| esta| este| mas| ninguna| ningun| la| el)? "
    r"(?:informacion|info|dato|datos|registro|registros|detalle|detalles)|"
    r"sin (?:informacion|info|dato|datos|registro|registros)|"
    r"no (?:se )?(?:pudo|puede) (?:determinar|saber|establecer|precisar)|"
    r"no se (?:determino|registro|reporto|especifico|menciono)|"
    r"no (?:consta|recuerdo|recuerda|aplica|disponible|especificado|determinado|reportado)"
    r")\s*(?:$|[,.;:!?]|\s+(?:porque|ya|pues|aun|todavia|al respecto|de eso|sobre eso)\b)",
)


def _fold(text):
    """minúsculas y sin acentos: 'No sé' -> 'no se'."""
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def is_no_info(respuesta):
    folded = _fold(respuesta).strip()
    # "saltar ..." / "omitir ..." siempre omiten el tema (como en chat_cli.py).
    return folded.startswith(("saltar", "omitir")) or bool(_NO_INFO.match(folded))


NO_INFO_ACK = "Entendido, lo registro como sin información y seguimos."

# "otro" no es reconstruible por dinámica; chat_cli.py tampoco lo ofrece.
MODALIDADES = {k: v for k, v in schema.MODALIDADES.items() if k != "otro"}

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/wasm", ".wasm")


class ChatbotError(Exception):
    def __init__(self, status, message, hint=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.hint = hint


# ------------------------------------------------------------------ Ollama
def _ollama_request(path, payload=None, timeout=OLLAMA_TIMEOUT):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{OLLAMA_URL}{path}", data=data, method="POST" if payload is not None else "GET",
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


# Una sola generación a la vez: en una PC sin GPU, varias en paralelo solo hacen todo más lento.
_ollama_slot = threading.Lock()


def ollama_chat(system, user, max_tokens):
    """Equivale a `run()` de chat_cli.py, pero contra Ollama."""
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "options": {"temperature": 0, "num_predict": max_tokens},
    }
    try:
        with _ollama_slot:
            data = _ollama_request("/api/chat", payload)
    except urllib.error.HTTPError as err:  # antes que URLError: es su subclase
        detail = err.read().decode("utf-8", "replace")[:200]
        if err.code == 404:
            raise ChatbotError(
                503, f"Ollama no tiene el modelo '{OLLAMA_MODEL}'.",
                f"Créalo con: ollama create {OLLAMA_MODEL} -f Modelfile")
        raise ChatbotError(502, f"Ollama respondió con error {err.code}: {detail}")
    except TimeoutError:
        raise ChatbotError(504, "Ollama tardó demasiado en responder.",
                           "La primera respuesta carga el modelo en memoria; vuelve a intentarlo.")
    except OSError:
        raise ChatbotError(503, f"No se pudo conectar con Ollama en {OLLAMA_URL}.",
                           "Abre la aplicación de Ollama o ejecuta: ollama serve")
    return (data.get("message") or {}).get("content", "").strip()


def ollama_status():
    try:
        tags = _ollama_request("/api/tags", timeout=3)
    except Exception:
        return False, False
    names = [m.get("name", "") for m in tags.get("models", [])]
    installed = any(n == OLLAMA_MODEL or n.startswith(OLLAMA_MODEL + ":") for n in names)
    return True, installed


# ------------------------------------------------------------------ entrevistas
_sessions = {}
_locks = {}
_guard = threading.Lock()


def _lock_for(case_id):
    with _guard:
        return _locks.setdefault(case_id, threading.Lock())


def _save():
    try:
        tmp = DATA_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_sessions, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(DATA_FILE)
    except OSError as err:
        print(f"[aviso] no se pudo guardar {DATA_FILE}: {err}", file=sys.stderr)


def _load():
    try:
        _sessions.update(json.loads(DATA_FILE.read_text(encoding="utf-8")))
        print(f"[info] {len(_sessions)} entrevista(s) restaurada(s) de {DATA_FILE.name}")
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as err:
        print(f"[aviso] no se pudo leer {DATA_FILE}: {err}", file=sys.stderr)


def _topics(s):
    return schema.topics_for(s["modalidad"], s["vehiculos"])


def _pending(s):
    return [t for t in _topics(s) if t["id"] not in s["estado"] and t["id"] not in s["form"]]


def _public(s, aviso=None):
    topics = _topics(s)
    total = len(topics)
    answered = total - len(_pending(s))
    out = {
        "caseId": s["caseId"], "modalidad": s["modalidad"], "vehiculos": s["vehiculos"],
        "estado": s["estado"], "tema": s["tema"], "pregunta": s["pregunta"],
        "answered": answered, "total": total,
        "progress": int(100 * answered / total) if total else 100,
        "done": s["done"], "transcript": s["transcript"],
        # Descripción legible de cada tema, para el informe PDF.
        "temas": {t["id"]: t["desc"] for t in topics},
        # Temas que el perito omitió o para los que no tenía información.
        "sinInformacion": [k for k, v in s["estado"].items() if v == schema.SALTADO],
    }
    if aviso:
        out["aviso"] = aviso
    return out


def _ask_next(s):
    """Elige el siguiente tema pendiente y redacta la pregunta (equivale al bucle de chat_cli.py)."""
    pend = _pending(s)
    if not pend:
        s.update(done=True, tema=None, pregunta=None)
        faltan = sum(1 for v in s["estado"].values() if v == schema.SALTADO)
        if faltan:
            texto = (f"Terminamos la entrevista. Quedaron {faltan} tema(s) sin información; "
                     "se marcan como datos faltantes en el JSON para Unity. "
                     "Ya puedes descargarlo y generar la simulación.")
        else:
            texto = schema.FIN_TEXT
        s["transcript"].append({"role": "assistant", "text": texto})
        return
    last = tuple(s["last"]) if s["last"] else None
    raw = ollama_chat(schema.SYSTEM_Q,
                      schema.build_q_user(s["modalidad"], s["vehiculos"], s["form"], s["estado"], pend, last),
                      200)
    tema, pregunta = schema.parse_q(raw)
    if tema not in {t["id"] for t in pend} or not pregunta:
        # El código manda: si el modelo se sale de la lista, se fuerza el primer pendiente
        # y se usa una pregunta genérica (la del modelo hablaba de otro tema).
        tema = pend[0]["id"]
        pregunta = f"Indícame lo siguiente: {pend[0]['desc']}."
    s.update(tema=tema, pregunta=pregunta, done=False)
    s["transcript"].append({"role": "assistant", "text": pregunta})


def _clean_vehicles(raw):
    vehs = {}
    if isinstance(raw, dict):
        for key in ("V1", "V2", "V3"):
            value = str(raw.get(key, "")).strip()
            if value:
                vehs[key] = value[:120]
    return vehs or {"V1": "vehículo 1"}


def _case_id(body):
    case_id = str(body.get("caseId", "")).strip()
    if not case_id or len(case_id) > 80:
        raise ChatbotError(400, "caseId es obligatorio (máx. 80 caracteres).")
    return case_id


def start_interview(body):
    case_id = _case_id(body)
    modalidad = body.get("modalidad")
    if modalidad not in MODALIDADES:
        raise ChatbotError(400, f"modalidad inválida. Opciones: {', '.join(MODALIDADES)}")
    form = body.get("form") if isinstance(body.get("form"), dict) else {}
    s = {"caseId": case_id, "modalidad": modalidad, "vehiculos": _clean_vehicles(body.get("vehiculos")),
         "form": form, "estado": {}, "last": None, "tema": None, "pregunta": None,
         "done": False, "transcript": []}
    with _lock_for(case_id):
        _ask_next(s)  # si Ollama falla, no se guarda nada
        _sessions[case_id] = s
        _save()
    return _public(s)


def answer_interview(body):
    case_id = _case_id(body)
    respuesta = str(body.get("respuesta", "")).strip()[:2000]
    if not respuesta:
        raise ChatbotError(400, "respuesta es obligatoria.")
    with _lock_for(case_id):
        current = _sessions.get(case_id)
        if not current:
            raise ChatbotError(404, "No hay una entrevista iniciada para este expediente.")
        if current["done"]:
            raise ChatbotError(409, "La entrevista ya está completa.")
        s = json.loads(json.dumps(current))  # copia: solo se confirma si todo sale bien
        by_id = {t["id"]: t for t in _topics(s)}
        tema, pregunta = s["tema"], s["pregunta"]
        aviso = None
        sin_info = is_no_info(respuesta)
        if sin_info:
            # El perito no tiene el dato: se marca como saltado (igual que en el entrenamiento)
            # sin llamar al modelo, y se pasa al siguiente tema.
            valor = schema.SALTADO
        else:
            out = ollama_chat(schema.SYSTEM_E,
                              schema.build_e_user(s["modalidad"], s["vehiculos"], tema,
                                                  by_id[tema]["desc"], pregunta, respuesta),
                              120)
            data = schema.parse_json_loose(out)
            if isinstance(data, dict) and tema in data:
                # norm_value (schema.py) convierte en None valores como "no especificado".
                valor = schema.norm_value(tema, data[tema])
                if valor is None:
                    valor, sin_info = schema.SALTADO, True
            else:
                valor = respuesta
                aviso = "No pude estructurar la respuesta; se guardó el texto tal cual."
        s["estado"][tema] = valor
        s["last"] = [pregunta, respuesta]
        s["transcript"].append({"role": "user", "text": respuesta})
        if sin_info:
            s["transcript"].append({"role": "assistant", "text": NO_INFO_ACK})
        _ask_next(s)
        _sessions[case_id] = s
        _save()
    return _public(s, aviso)


def get_interview(case_id):
    s = _sessions.get(case_id)
    if not s:
        raise ChatbotError(404, "No hay una entrevista iniciada para este expediente.")
    return _public(s)


def reset_interview(body):
    case_id = _case_id(body)
    with _lock_for(case_id):
        _sessions.pop(case_id, None)
        _save()
    return {"ok": True}


def status():
    ollama_up, installed = ollama_status()
    info = {"ok": True, "service": "cesvi-chatbot", "model": OLLAMA_MODEL, "ollama": ollama_up,
            "modelInstalled": installed, "available": ollama_up and installed,
            "modalidades": MODALIDADES}
    if not ollama_up:
        info["hint"] = "Ollama no está activo. Abre la aplicación de Ollama o ejecuta: ollama serve"
    elif not installed:
        info["hint"] = f"Falta el modelo. Créalo con: ollama create {OLLAMA_MODEL} -f Modelfile"
    return info


# ------------------------------------------------------------------ expedientes
# Igual que server/index.js: datos en memoria, solo para que la web cargue sus escenas.
_cases = {}
_cases_guard = threading.Lock()


def _ensure_case(case_id):
    with _cases_guard:
        if case_id not in _cases:
            _cases[case_id] = {
                "id": case_id, "name": "Reconstrucción vial", "location": "",
                "scenes": [{"id": str(uuid.uuid4()), "name": n, "order": i + 1}
                           for i, n in enumerate(["Inicio", "Aproximación", "Impacto", "Posición final"])],
            }
        return _cases[case_id]


def _find_scene(scene_id):
    for c in _cases.values():
        for scene in c["scenes"]:
            if scene["id"] == scene_id:
                return c, scene
    return None, None


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "CESVI/1.0"

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _send(self, status_code, payload):
        body = b"" if status_code == 204 else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        if status_code != 204:
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            raise ChatbotError(413, "La petición es demasiado grande.")
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            raise ChatbotError(400, "El cuerpo debe ser JSON válido.")
        return data if isinstance(data, dict) else {}

    # ---- archivos de la web (dist/)
    def _serve_static(self, path, head_only=False):
        if not (DIST_DIR / "index.html").is_file():
            body = ("<h1>Falta compilar la web</h1><p>Ejecuta <code>npm run build</code> en la carpeta "
                    "del proyecto y vuelve a abrir esta página.</p>").encode("utf-8")
            self.send_response(503)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return
        rel = urllib.parse.unquote(path).lstrip("/")
        target = (DIST_DIR / rel).resolve() if rel else DIST_DIR / "index.html"
        # Impide salir de dist/ con rutas como /../../secretos
        if DIST_DIR not in target.parents and target != DIST_DIR / "index.html":
            target = DIST_DIR / "index.html"
        if not target.is_file():
            # Aplicación de una sola página: cualquier ruta desconocida muestra index.html.
            target = DIST_DIR / "index.html"
        data = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # Los archivos de assets/ llevan hash en el nombre: se pueden guardar en caché para siempre.
        cache = "public, max-age=31536000, immutable" if "/assets/" in f"/{rel}" else "no-cache"
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def _api(self, method, parts):
        # parts = ruta sin el prefijo /api, dividida por "/"
        if method == "GET" and parts in (["health"], ["ai", "status"]):
            return self._send(200, status())

        if parts[:2] == ["ai", "interview"]:
            action = parts[2] if len(parts) > 2 else ""
            if method == "GET" and action == "modalidades":
                return self._send(200, MODALIDADES)
            if method == "GET" and action:
                return self._send(200, get_interview(action))
            if method == "POST" and action == "start":
                return self._send(200, start_interview(self._body()))
            if method == "POST" and action == "answer":
                return self._send(200, answer_interview(self._body()))
            if method == "POST" and action == "reset":
                return self._send(200, reset_interview(self._body()))

        if len(parts) >= 2 and parts[0] == "cases":
            case = _ensure_case(parts[1][:80])
            if len(parts) == 2 and method == "GET":
                return self._send(200, case)
            if parts[2:] == ["scenes"] and method == "GET":
                return self._send(200, sorted(case["scenes"], key=lambda s: s["order"]))
            if parts[2:] == ["scenes"] and method == "POST":
                body = self._body()
                name = str(body.get("name", "")).strip()[:80]
                if not name:
                    raise ChatbotError(400, "name requerido")
                order = body.get("order") if isinstance(body.get("order"), int) else len(case["scenes"]) + 1
                scene = {"id": str(uuid.uuid4()), "name": name, "order": order}
                case["scenes"].append(scene)
                return self._send(201, scene)

        if len(parts) == 2 and parts[0] == "scenes" and method in ("PATCH", "DELETE"):
            case, scene = _find_scene(parts[1])
            if not scene:
                raise ChatbotError(404, "escena no encontrada")
            if method == "PATCH":
                name = str(self._body().get("name", "")).strip()[:80]
                if name:
                    scene["name"] = name
                return self._send(200, scene)
            case["scenes"] = [s for s in case["scenes"] if s["id"] != parts[1]]
            return self._send(204, None)

        if parts == ["ai", "chat"] and method == "POST":
            # El chat libre del servidor Node necesita Groq/Gemini; este servidor no lo implementa.
            raise ChatbotError(501, "El chat libre no está disponible. Usa la pestaña Entrevista IA.")

        raise ChatbotError(404, "Ruta no encontrada.")

    def _dispatch(self, method):
        path = self.path.split("?")[0]
        if not path.startswith("/api/"):
            if method in ("GET", "HEAD"):
                return self._serve_static(path, head_only=method == "HEAD")
            return self._send(405, {"error": "Método no permitido."})
        parts = [urllib.parse.unquote(p) for p in path[len("/api/"):].split("/") if p]
        try:
            self._api(method, parts)
        except ChatbotError as err:
            payload = {"error": err.message, "message": err.message}
            if err.hint:
                payload["hint"] = err.hint
            self._send(err.status, payload)
        except Exception as err:  # noqa: BLE001 - nunca dejar la conexión colgada
            print(f"[error] {err!r}", file=sys.stderr)
            self._send(500, {"error": "Error interno del servidor.", "message": "Error interno del servidor."})

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


def main():
    _load()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"CESVI listo en http://{HOST}:{PORT}")
    print(f"Modelo de Ollama: '{OLLAMA_MODEL}' en {OLLAMA_URL}")
    if not (DIST_DIR / "index.html").is_file():
        print(f"[aviso] No encontré la web compilada en {DIST_DIR}. Ejecuta: npm run build")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDetenido.")


if __name__ == "__main__":
    main()
