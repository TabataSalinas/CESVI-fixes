"""
Esquema compartido: modalidades, catálogo de temas y constructores de prompts.

IMPORTANTE: build_dataset.py y chat_cli.py usan EXACTAMENTE las mismas funciones
de prompt, para que lo que ve el modelo en producción sea idéntico a lo que vio
en entrenamiento.

El JSON final para Unity se definirá después; por ahora el "estado" del caso es
un diccionario plano {id_tema: valor}.
"""
import json
import re

SALTADO = "__saltado__"

# Formas en que el modelo maestro dice "el reporte no lo dice" en vez de usar null. Si pasaran como
# valor, el modelo final aprendería a responder "no especificado" en vez de "saltar".
# Ojo: frases como "no se encontraron huellas de frenado" SÍ son un hecho y no deben anularse.
_NULLISH_FULL = re.compile(r"^(null|none|n/?a|-+|\?|desconocid[oa]s?|sin datos?|no aplica|no disponible|"
                           r"sin especificar|no)\.?$", re.I)
_NULLISH_PART = re.compile(r"\bno (se )?(especifica|menciona|indica|reporta|determina|precisa|describe)n?\b|"
                           r"\bno (especificad|mencionad|determinad|indicad|reportad|precisad)[oa]s?\b|"
                           r"\b(ubicaci[oó]n|posici[oó]n|direcci[oó]n) desconocida\b|"
                           r"\bno hay (informaci[oó]n|datos?)\b|\bsin informaci[oó]n\b", re.I)


def norm_value(tema, v):
    """Convierte en None los valores que en realidad significan "el reporte no lo dice"."""
    if not isinstance(v, str):
        return v
    v = v.strip()
    if not v or _NULLISH_FULL.match(v):
        return None
    # Las declaraciones se transcriben: "un vehículo desconocido me pegó" es un dato real.
    if not tema.startswith("declaracion_") and _NULLISH_PART.search(v):
        return None
    return v

MODALIDADES = {
    "alcance": "Alcance (un vehículo golpea por detrás a otro), incluye alcance con proyección",
    "colision_lateral_angular": "Colisión lateral, perpendicular, angular o corte de circulación",
    "colision_frontal": "Colisión frontal (vehículos que circulan en sentidos opuestos)",
    "objeto_fijo": "Choque contra objeto fijo, despiste o salida de camino",
    "volcadura": "Volcadura",
    "reversa": "Impacto por maniobra en reversa",
    "otro": "Otro (incendio, informe de daños, no reconstruible por dinámica)",
}

# Cada tema: id (con {V} si es por vehículo), desc, source ("chat" | "form"),
# prio (menor = se pregunta antes), mods ("*" o lista), veh (True si es por vehículo)
_T = []


def _t(id_, desc, prio, mods="*", veh=False, source="chat"):
    _T.append(dict(id=id_, desc=desc, prio=prio, mods=mods, veh=veh, source=source))


# --- Generales ---
_t("declaracion_{V}", "Declaración del conductor de {V} sobre cómo ocurrió el hecho (resumen)", 5, veh=True)
_t("superficie", "Condición de la superficie de rodamiento (seca, mojada, grava, etc.)", 10)
_t("iluminacion", "Iluminación y visibilidad (día/noche, alumbrado, lluvia, niebla)", 11)
_t("sentido_carril_{V}", "Sentido de circulación y carril por el que iba {V}", 20, veh=True)
_t("velocidad_{V}_kmh", "Velocidad estimada de {V} antes del evento (km/h)", 21, veh=True)
_t("maniobra_previa_{V}", "Maniobra de {V} antes del impacto (frenado, aceleración, giro, cambio de carril, detenido)", 22, veh=True)

# --- Específicos por modalidad ---
_t("distancia_previa", "Distancia o tiempo de separación entre los vehículos antes de la frenada/evento", 30, mods=["alcance"])
_t("senalizacion_preferencia", "Semáforo, señal de alto/ceda el paso o quién tenía preferencia de paso", 31,
   mods=["colision_lateral_angular", "colision_frontal"])
_t("tipo_objeto", "Tipo de objeto impactado, su material y su altura", 32, mods=["objeto_fijo"])
_t("causa_perdida_control", "Causa de la pérdida de control (derrape, reventón, esquivar, distracción, etc.)", 33,
   mods=["objeto_fijo", "volcadura"])
_t("maniobra_reversa", "Dirección y tramo recorrido en reversa, y visibilidad del conductor", 34, mods=["reversa"])
_t("vueltas_volcadura", "Número de vueltas y sentido de la volcadura", 35, mods=["volcadura"])

# --- Hechos e impacto ---
_t("secuencia_eventos", "Orden y tipo de los impactos (primer contacto e impactos secundarios)", 40)
_t("punto_impacto_via", "Ubicación del punto de impacto en la vía (carril, distancia a una referencia)", 41)
_t("angulo_impacto", "Ángulo aproximado entre los vehículos al momento del impacto", 42,
   mods=["colision_lateral_angular", "colision_frontal"])
_t("altura_marca_objeto_cm", "Altura (cm) de las marcas del impacto en el objeto fijo", 45, mods=["objeto_fijo"])
_t("evidencias_sitio", "Evidencias en el sitio (huellas de frenado, restos, intercambio de pintura, marcas)", 50)
_t("huellas_frenado_m", "Longitud (m) de las huellas de frenado, si las hay", 51)
_t("airbags_{V}", "Bolsas de aire de {V}: cuáles se activaron", 60, veh=True)

# --- Datos que normalmente ya vienen del formulario / croquis (se pueden pre-llenar) ---
_t("danos_{V}", "Daños de {V}: zonas, altura (cm) y dirección de la fuerza", 70, veh=True, source="form")
_t("posicion_final_{V}", "Posición final de {V}: ubicación, rumbo y tipo de barrido", 71, veh=True, source="form")

TOPIC_CATALOG = _T
MAX_VEH = 3


def topics_for(modalidad, vehiculos):
    """Lista de temas expandidos (por vehículo) aplicables a la modalidad.
    vehiculos: dict {"V1": "descripción", ...}
    """
    vids = list(vehiculos.keys())[:MAX_VEH]
    if modalidad == "objeto_fijo":
        vids = vids[:1] or ["V1"]
    out = []
    for t in TOPIC_CATALOG:
        if t["mods"] != "*" and modalidad not in t["mods"]:
            continue
        if t["veh"]:
            for v in vids:
                out.append(dict(id=t["id"].format(V=v), desc=t["desc"].format(V=v),
                                prio=t["prio"], source=t["source"], base=t["id"]))
        else:
            out.append(dict(id=t["id"], desc=t["desc"], prio=t["prio"], source=t["source"], base=t["id"]))
    out.sort(key=lambda x: (x["prio"], x["id"]))
    return out


def known_topic_ids_regex():
    """Regex para validar ids de tema (acepta sufijo _V1.._V3)."""
    pats = []
    for t in TOPIC_CATALOG:
        p = re.escape(t["id"]).replace(re.escape("{V}"), r"V[1-3]").replace(r"\{V\}", r"V[1-3]")
        pats.append(p)
    return re.compile("^(" + "|".join(pats) + ")$")


def format_vehiculos(vehiculos):
    return "; ".join(f"{k}: {v}" for k, v in vehiculos.items())


# ------------------------------------------------------------------ prompts
SYSTEM_Q = (
    "Eres el asistente de un perito en reconstrucción de hechos de tránsito. Tu trabajo es entrevistar al perito "
    "para obtener, tema por tema, los datos necesarios para reconstruir el accidente. Haz UNA sola pregunta por turno, "
    "clara, técnica y concreta, adaptada al caso y a lo que ya se respondió. No repitas temas ya respondidos ni "
    "preguntes datos que ya vienen del formulario. Elige siempre un tema de la lista de PENDIENTES. "
    "Cuando no queden pendientes responde con TEMA: FIN.\n"
    "Formato de salida:\nTEMA: <id>\nPREGUNTA: <texto>"
)

SYSTEM_E = (
    "Extraes datos estructurados de la respuesta de un perito de tránsito. Recibes el tema preguntado y la respuesta. "
    "Devuelve SOLO un JSON con una llave (el id del tema) y su valor: números sin unidades cuando el tema sea numérico, "
    "texto breve y técnico en español en los demás casos. Usa solo lo que dice la respuesta; no inventes. "
    f'Si el perito escribe "saltar", el valor es "{SALTADO}".'
)

FIN_TEXT = ("Tengo toda la información necesaria para reconstruir el hecho. "
            "Puedes generar la simulación 3D y el peritaje.")


def build_q_user(modalidad, vehiculos, form, estado, pendientes, last_qa=None, max_pend=6):
    lines = [
        f"MODALIDAD: {modalidad}",
        f"VEHÍCULOS: {format_vehiculos(vehiculos)}",
        "FORMULARIO: " + (json.dumps(form, ensure_ascii=False) if form else "ninguno"),
        "ESTADO: " + (json.dumps(estado, ensure_ascii=False) if estado else "{}"),
        f"PENDIENTES (n={len(pendientes)}):",
    ]
    for t in pendientes[:max_pend]:
        lines.append(f"- {t['id']}: {t['desc']}")
    if not pendientes:
        lines.append("(ninguno)")
    if last_qa:
        lines += ["ÚLTIMO INTERCAMBIO:", f"P: {last_qa[0]}", f"R: {last_qa[1]}"]
    else:
        lines.append("ÚLTIMO INTERCAMBIO: (inicio de la entrevista)")
    return "\n".join(lines)


def build_e_user(modalidad, vehiculos, topic_id, topic_desc, pregunta, respuesta):
    return "\n".join([
        f"MODALIDAD: {modalidad}",
        f"VEHÍCULOS: {format_vehiculos(vehiculos)}",
        f"TEMA: {topic_id} — {topic_desc}",
        f"PREGUNTA: {pregunta}",
        f"RESPUESTA DEL PERITO: {respuesta}",
    ])


def build_q_assistant(tema, pregunta):
    return f"TEMA: {tema}\nPREGUNTA: {pregunta}"


def parse_q(text):
    m = re.search(r"TEMA:\s*(\S+)\s*\n\s*PREGUNTA:\s*(.+)", text, re.S)
    if not m:
        return None, text.strip()
    return m.group(1).strip(), m.group(2).strip()


def parse_json_loose(text):
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"[\[{].*[\]}]", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None
