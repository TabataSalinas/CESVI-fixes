"""Chat de prueba en terminal (sin UI) para probar el modelo entrenado.

El CÓDIGO lleva el checklist y el % de avance; el MODELO redacta la pregunta y extrae el valor.

Uso (con adaptadores, sin fusionar):
  python chat_cli.py --model Qwen/Qwen2.5-7B-Instruct --adapter-path ./cesvi_adapters_v2
Uso (modelo fusionado):
  python chat_cli.py --model ./cesvi_modelo_fused

Escribe "saltar" para omitir un tema, "salir" para terminar. Al final imprime el estado (JSON).
"""
import argparse
import json

from mlx_lm import generate, load

from schema import (MODALIDADES, SALTADO, SYSTEM_E, SYSTEM_Q, build_e_user, build_q_user,
                    parse_json_loose, parse_q, topics_for)


def run(model, tok, system, user, max_tokens=200):
    prompt = tok.apply_chat_template(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        add_generation_prompt=True, tokenize=False)
    return generate(model, tok, prompt=prompt, max_tokens=max_tokens, verbose=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--adapter-path", default=None)
    a = ap.parse_args()
    model, tok = load(a.model, adapter_path=a.adapter_path)

    mods = [m for m in MODALIDADES if m != "otro"]
    for i, m in enumerate(mods):
        print(f"{i}) {m} — {MODALIDADES[m]}")
    modalidad = mods[int(input("Modalidad: "))]
    vehiculos = {}
    for i in range(1, 4):
        d = input(f"Vehículo V{i} (marca tipo modelo color; Enter para terminar): ").strip()
        if not d:
            break
        vehiculos[f"V{i}"] = d
    vehiculos = vehiculos or {"V1": "vehículo 1"}

    topics = topics_for(modalidad, vehiculos)
    # El formulario real ya trae daños y posición final; aquí lo simulamos vacío (se preguntan en el chat).
    form = {}
    estado, last = {}, None
    by_id = {t["id"]: t for t in topics}
    total = len(topics)

    while True:
        pend = [t for t in topics if t["id"] not in estado and t["id"] not in form]
        if not pend:
            break
        raw = run(model, tok, SYSTEM_Q, build_q_user(modalidad, vehiculos, form, estado, pend, last))
        tema, pregunta = parse_q(raw)
        if tema not in {t["id"] for t in pend}:  # el código manda: si el modelo se sale de la lista, corrige
            tema = pend[0]["id"]
        done = total - len(pend)
        print(f"\n[{int(100 * done / total)}%] ({tema})\nIA: {pregunta}")
        resp = input("Perito: ").strip()
        if resp.lower() == "salir":
            break
        if resp.lower().startswith("saltar"):
            estado[tema] = SALTADO
        else:
            out = run(model, tok, SYSTEM_E,
                      build_e_user(modalidad, vehiculos, tema, by_id[tema]["desc"], pregunta, resp), 120)
            data = parse_json_loose(out)
            if isinstance(data, dict) and tema in data:
                estado[tema] = data[tema]
            else:
                print(f"  (no pude extraer un JSON válido: {out!r}; guardo el texto tal cual)")
                estado[tema] = resp
            print(f"  → {tema} = {estado[tema]!r}")
        last = (pregunta, resp)

    print("\n=== ESTADO FINAL ===")
    print(json.dumps({"modalidad": modalidad, "vehiculos": vehiculos, "estado": estado},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
