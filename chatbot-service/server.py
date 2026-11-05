"""Servicio local del asistente pericial de CESVI.

Envuelve la entrevista de `chat_cli.py` en una API HTTP para que la web de CESVI
pueda usarla. El CÓDIGO lleva el checklist y el % de avance; el MODELO (Ollama)
solo redacta cada pregunta y extrae el valor de cada respuesta.

- Reutiliza `schema.py` (raíz del repo) SIN modificarlo: los prompts son idénticos
  a los de entrenamiento.
- Solo usa la biblioteca estándar de Python: no hay nada que instalar con pip.
- Escucha solo en 127.0.0.1. La web lo llama a través de /api/ai/* (api/router.ts).

Uso:  python chatbot-service/server.py
"""
import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))  # schema.py vive en la raíz del repo
import schema  # noqa: E402

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "cesvi")
OLLAMA_TIMEOUT = int(os.environ.get("OLLAMA_TIMEOUT", "300"))  # la 1ª carga del modelo puede tardar
HOST = os.environ.get("CHATBOT_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHATBOT_PORT", "8787"))
DATA_FILE = Path(os.environ.get("CHATBOT_DATA", ROOT / "sessions.json"))

# "otro" no es reconstruible por dinámica; chat_cli.py tampoco lo ofrece.
MODALIDADES = {k: v for k, v in schema.MODALIDADES.items() if k != "otro"}


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


def ollama_chat(system, user, max_tokens):
    """Equivale a `run()` de chat_cli.py, pero contra Ollama."""
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "keep_alive": "30m",  # mantiene el modelo en memoria entre preguntas
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "options": {"temperature": 0, "num_predict": max_tokens},
    }
    try:
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


# ------------------------------------------------------------------ sesiones
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
        print(f"[info] {len(_sessions)} sesión(es) restaurada(s) de {DATA_FILE.name}")
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as err:
        print(f"[aviso] no se pudo leer {DATA_FILE}: {err}", file=sys.stderr)


def _topics(s):
    return schema.topics_for(s["modalidad"], s["vehiculos"])


def _pending(s):
    return [t for t in _topics(s) if t["id"] not in s["estado"] and t["id"] not in s["form"]]


def _public(s, aviso=None):
    total = len(_topics(s))
    answered = total - len(_pending(s))
    out = {
        "caseId": s["caseId"], "modalidad": s["modalidad"], "vehiculos": s["vehiculos"],
        "estado": s["estado"], "tema": s["tema"], "pregunta": s["pregunta"],
        "answered": answered, "total": total,
        "progress": int(100 * answered / total) if total else 100,
        "done": s["done"], "transcript": s["transcript"],
    }
    if aviso:
        out["aviso"] = aviso
    return out


def _ask_next(s):
    """Elige el siguiente tema pendiente y redacta la pregunta (equivale al bucle de chat_cli.py)."""
    pend = _pending(s)
    if not pend:
        s.update(done=True, tema=None, pregunta=None)
        s["transcript"].append({"role": "assistant", "text": schema.FIN_TEXT})
        return
    last = tuple(s["last"]) if s["last"] else None
    raw = ollama_chat(schema.SYSTEM_Q,
                      schema.build_q_user(s["modalidad"], s["vehiculos"], s["form"], s["estado"], pend, last),
                      200)
    tema, pregunta = schema.parse_q(raw)
    if tema not in {t["id"] for t in pend} or not pregunta:
        # El código manda: si el modelo se sale de la lista, se fuerza el primer pendiente.
        # Además se descarta su pregunta (hablaba de otro tema) y se usa una genérica.
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
    respuesta = str(body.get("respuesta", "")).strip()
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
        if respuesta.lower().startswith("saltar"):
            valor = schema.SALTADO
        else:
            out = ollama_chat(schema.SYSTEM_E,
                              schema.build_e_user(s["modalidad"], s["vehiculos"], tema,
                                                  by_id[tema]["desc"], pregunta, respuesta),
                              120)
            data = schema.parse_json_loose(out)
            if isinstance(data, dict) and tema in data:
                valor = data[tema]
            else:
                valor = respuesta
                aviso = "No pude estructurar la respuesta; se guardó el texto tal cual."
        s["estado"][tema] = valor
        s["last"] = [pregunta, respuesta]
        s["transcript"].append({"role": "user", "text": respuesta})
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


# ------------------------------------------------------------------ HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "CESVIChatbot/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def _send(self, status_code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            raise ChatbotError(400, "El cuerpo debe ser JSON válido.")
        return data if isinstance(data, dict) else {}

    def _dispatch(self, method):
        path = self.path.split("?")[0].rstrip("/")
        try:
            if method == "GET" and path == "/health":
                return self._send(200, status())
            if method == "GET" and path.startswith("/interview/"):
                return self._send(200, get_interview(urllib.parse.unquote(path[len("/interview/"):])))
            if method == "POST" and path == "/interview/start":
                return self._send(200, start_interview(self._body()))
            if method == "POST" and path == "/interview/answer":
                return self._send(200, answer_interview(self._body()))
            if method == "POST" and path == "/interview/reset":
                return self._send(200, reset_interview(self._body()))
            raise ChatbotError(404, "Ruta no encontrada.")
        except ChatbotError as err:
            payload = {"error": err.message}
            if err.hint:
                payload["hint"] = err.hint
            self._send(err.status, payload)
        except Exception as err:  # noqa: BLE001 - nunca dejar la conexión colgada
            print(f"[error] {err!r}", file=sys.stderr)
            self._send(500, {"error": "Error interno del servicio del chatbot."})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")


def main():
    _load()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Servicio CESVI del chatbot en http://{HOST}:{PORT}")
    print(f"Modelo de Ollama: '{OLLAMA_MODEL}' en {OLLAMA_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDetenido.")


if __name__ == "__main__":
    main()
