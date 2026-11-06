/**
 * JSON completo para reconstruir el siniestro en Unity.
 *
 * Junta en un solo archivo:
 *  - la geometría del mapa (ancla, vehículos, trayectorias, impacto, posición final, evidencias,
 *    objetos), en METROS respecto al ancla (sistema ENU local), y
 *  - los datos de la entrevista pericial (velocidades, maniobras, condiciones, daños, etc.).
 *
 * Los datos que el perito no tenía quedan en null y se listan en `datos_faltantes`,
 * para que la simulación decida qué suponer en lugar de inventar valores en silencio.
 */
import type { GeoPosition } from "./geo"
import type { RelativeEvidence, RelativeItem, RelativeVehicle } from "./migration"
import { INTERVIEW_SKIPPED, type InterviewState } from "./interviewApi"

export const UNITY_FORMAT = "cesvi.unity.simulacion"
export const UNITY_FORMAT_VERSION = "3.0.0"

type Punto = { x: number; y: number }

export type UnitySimulationInput = {
  caseId: string
  anchor: GeoPosition
  locationQuery?: string
  vehicles: Record<string, RelativeVehicle>
  impact: Punto
  impactVehicles?: string[]
  impactTime?: string
  evidence: RelativeEvidence[]
  droppedItems: RelativeItem[]
  interview: InterviewState
  /** Descripción legible de la modalidad (p. ej. "Alcance (un vehículo golpea por detrás...)"). */
  modalidadDescripcion?: string
  modelo?: string
}

const redondear = (n: number, decimales = 3) => {
  const f = 10 ** decimales
  return Math.round(n * f) / f
}

/** Rumbo en 0–360°, 0 = Norte, sentido horario (la misma convención del mapa). */
const rumbo = (grados: number | undefined) =>
  grados === undefined || !Number.isFinite(grados) ? null : redondear(((grados % 360) + 360) % 360, 1)

const punto = (p: Punto) => ({ x: redondear(p.x), y: redondear(p.y) })

/** Valor de la entrevista, o null si el perito no tenía la información. */
function dato(estado: Record<string, unknown>, id: string): unknown {
  const v = estado[id]
  if (v === undefined || v === null || v === INTERVIEW_SKIPPED) return null
  if (typeof v === "string" && !v.trim()) return null
  return v
}

/** Número de un tema numérico ("45", 45, "45 km/h"). Si no empieza con un número, null. */
function numero(estado: Record<string, unknown>, id: string): number | null {
  const v = dato(estado, id)
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const m = v.trim().match(/^-?\d+(?:[.,]\d+)?/)
    if (m) return Number(m[0].replace(",", "."))
  }
  return null
}

const texto = (estado: Record<string, unknown>, id: string): string | null => {
  const v = dato(estado, id)
  if (v === null) return null
  return typeof v === "string" ? v : JSON.stringify(v)
}

export function buildUnitySimulation(input: UnitySimulationInput) {
  const iv = input.interview
  const e = iv.estado
  const ids = Array.from(
    new Set([...Object.keys(input.vehicles), ...Object.keys(iv.vehiculos)]),
  ).sort()

  const vehiculos = ids.map((id) => {
    const v = input.vehicles[id]
    const velEntrevista = numero(e, `velocidad_${id}_kmh`)
    const velMapa = typeof v?.speed === "number" && Number.isFinite(v.speed) ? v.speed : null
    return {
      id,
      descripcion: iv.vehiculos[id] ?? null,
      tipo: v?.type ?? null,
      modelo: v?.model ?? null,
      escala: v?.scale ?? 1,
      en_mapa: Boolean(v),
      participa_en_impacto: input.impactVehicles ? input.impactVehicles.includes(id) : null,
      posicion_inicial: v ? { ...punto(v), rumbo_deg: rumbo(v.rotation) } : null,
      trayectoria: (v?.trajectoryPoints ?? []).map(punto),
      posicion_final: v?.postImpactOffset
        ? { ...punto(v.postImpactOffset), rumbo_deg: rumbo(v.postImpactOffset.rotation) }
        : null,
      posicion_final_descripcion: texto(e, `posicion_final_${id}`),
      // La declaración de la entrevista tiene prioridad sobre el valor de ejemplo del mapa.
      velocidad_kmh: velEntrevista ?? velMapa,
      velocidad_ms: (velEntrevista ?? velMapa) === null ? null : redondear((velEntrevista ?? velMapa)! / 3.6, 2),
      velocidad_fuente: velEntrevista !== null ? "entrevista" : velMapa !== null ? "mapa" : null,
      sentido_carril: texto(e, `sentido_carril_${id}`),
      maniobra_previa: texto(e, `maniobra_previa_${id}`),
      zona_impacto: v?.impactZone ?? null,
      danos: texto(e, `danos_${id}`),
      bolsas_aire: texto(e, `airbags_${id}`),
      declaracion_conductor: texto(e, `declaracion_${id}`),
    }
  })

  // Temas sin información: los que el perito omitió y los que aún no se preguntaron.
  const temas = iv.temas ?? {}
  const faltantes = Object.keys(temas)
    .filter((id) => dato(e, id) === null)
    .map((id) => ({
      id,
      descripcion: temas[id],
      motivo: e[id] === INTERVIEW_SKIPPED ? "sin_informacion" : "no_preguntado",
    }))

  const respuestas: Record<string, unknown> = {}
  for (const id of Object.keys(temas)) respuestas[id] = dato(e, id)

  return {
    formato: UNITY_FORMAT,
    version: UNITY_FORMAT_VERSION,
    metadata: {
      caseId: input.caseId,
      generado: new Date().toISOString(),
      entrevista_completa: iv.done,
      progreso_entrevista: iv.progress,
      modelo_ia: input.modelo ?? null,
      fuente_cartografica: "© OpenStreetMap contributors (https://www.openstreetmap.org/copyright)",
    },
    sistema_coordenadas: {
      tipo: "ENU local (plano tangente al ancla)",
      origen: { lat: input.anchor.lat, lng: input.anchor.lng },
      unidades: "metros",
      ejes: { x: "Este (+) / Oeste (-)", y: "Norte (+) / Sur (-)" },
      rumbo: "grados 0-360; 0 = Norte, 90 = Este, sentido horario",
      unity: "position = new Vector3(x, 0, y); rotation = Quaternion.Euler(0, rumbo_deg, 0)",
    },
    escena: {
      ubicacion: input.locationQuery ?? null,
      modalidad: { id: iv.modalidad, descripcion: input.modalidadDescripcion ?? null },
      superficie: texto(e, "superficie"),
      iluminacion: texto(e, "iluminacion"),
      distancia_previa_entre_vehiculos: texto(e, "distancia_previa"),
      senalizacion_preferencia: texto(e, "senalizacion_preferencia"),
      objeto_impactado: texto(e, "tipo_objeto"),
      causa_perdida_control: texto(e, "causa_perdida_control"),
      maniobra_reversa: texto(e, "maniobra_reversa"),
      volcadura_vueltas: texto(e, "vueltas_volcadura"),
    },
    vehiculos,
    impacto: {
      posicion: punto(input.impact),
      tiempo: input.impactTime ?? null,
      vehiculos: input.impactVehicles ?? [],
      secuencia_eventos: texto(e, "secuencia_eventos"),
      punto_en_via: texto(e, "punto_impacto_via"),
      angulo_deg: numero(e, "angulo_impacto"),
      angulo_descripcion: texto(e, "angulo_impacto"),
      altura_marca_objeto_cm: numero(e, "altura_marca_objeto_cm"),
    },
    evidencias: {
      marcadores: input.evidence.map((ev) => ({ label: ev.label, ...punto(ev) })),
      descripcion_sitio: texto(e, "evidencias_sitio"),
      huellas_frenado_m: numero(e, "huellas_frenado_m"),
    },
    objetos: input.droppedItems.map((o) => ({
      id: o.id,
      etiqueta: o.label,
      tipo: o.kind,
      ...punto(o),
      rumbo_deg: rumbo(o.rotation),
      escala: o.scale,
    })),
    entrevista: {
      modalidad: iv.modalidad,
      vehiculos: iv.vehiculos,
      respuestas,
    },
    datos_faltantes: faltantes,
  }
}

export type UnitySimulation = ReturnType<typeof buildUnitySimulation>

export function downloadUnitySimulation(input: UnitySimulationInput): UnitySimulation {
  const data = buildUnitySimulation(input)
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `${input.caseId}-simulacion-unity.json`
  // Firefox necesita el enlace en el documento; revocar de inmediato puede cancelar la descarga.
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  return data
}
