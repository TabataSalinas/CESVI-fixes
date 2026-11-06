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
import { getVehicleVariant, type VehicleVariant } from "../components/map/vehicleUtils"

export const UNITY_FORMAT = "cesvi.unity.simulacion"
export const UNITY_FORMAT_VERSION = "3.1.0"

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


// ---------------------------------------------------------------------------
// Bloque para Unity: ejes de Unity (X = Este, Y = arriba, Z = Norte), origen en el punto de impacto,
// línea de tiempo con keyframes. Se AGREGA al formato anterior; no reemplaza ningún campo.
// ---------------------------------------------------------------------------

const FPS = 30

/** Suma 0 para evitar "-0" en el JSON. */
const r = (n: number, decimales = 2) => redondear(n, decimales) + 0

const rad = (g: number) => (g * Math.PI) / 180

/** Dimensiones y masa de referencia por tipo de vehículo (ESTIMADAS, no vienen del expediente). */
const FICHA_VEHICULO: Record<VehicleVariant, { categoria: string; largo: number; ancho: number; alto: number; masa: number }> = {
  car: { categoria: "Automóvil", largo: 4.46, ancho: 1.74, alto: 1.46, masa: 1100 },
  van: { categoria: "Camioneta", largo: 5.3, ancho: 1.95, alto: 1.9, masa: 2100 },
  truck: { categoria: "Camión", largo: 8.5, ancho: 2.5, alto: 3.2, masa: 8000 },
  bus: { categoria: "Autobús", largo: 12, ancho: 2.55, alto: 3.2, masa: 12000 },
  motorcycle: { categoria: "Motocicleta", largo: 2.1, ancho: 0.8, alto: 1.2, masa: 200 },
  bicycle: { categoria: "Bicicleta", largo: 1.8, ancho: 0.6, alto: 1.1, masa: 90 },
  tractor: { categoria: "Tractor", largo: 4.5, ancho: 2.2, alto: 2.8, masa: 5000 },
}

const VARIANTES: VehicleVariant[] = ["car", "van", "truck", "bus", "motorcycle", "bicycle", "tractor"]

function variante(tipo: string | undefined): VehicleVariant {
  const t = (tipo ?? "car").toLowerCase()
  return (VARIANTES as string[]).includes(t) ? (t as VehicleVariant) : getVehicleVariant(t)
}

const TIPO_COLISION: Record<string, string> = {
  alcance: "alcance",
  colision_lateral_angular: "angular",
  colision_frontal: "frontal",
  objeto_fijo: "objeto_fijo",
  volcadura: "volcadura",
  reversa: "reversa",
}

/** "Costado izquierdo" -> "costado_izquierdo" */
const slug = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")

/** Coeficiente de fricción de referencia según lo que dijo el perito sobre la superficie. */
function superficieInfo(texto: string | null): { superficie: string | null; mu: number | null } {
  if (!texto) return { superficie: null, mu: null }
  const t = slug(texto)
  const tabla: Array<[RegExp, string, number]> = [
    [/hielo|nieve|escarcha/, "hielo_nieve", 0.15],
    [/grava|balasto|terraceria|tierra|lodo/, "grava_tierra", 0.5],
    [/moj|lluv|hume|charco/, "asfalto_mojado", 0.45],
    [/concreto|cemento/, "concreto_seco", 0.8],
    [/sec|asfalto/, "asfalto_seco", 0.75],
  ]
  for (const [re, nombre, mu] of tabla) if (re.test(t)) return { superficie: nombre, mu }
  return { superficie: slug(texto), mu: null }
}

function climaDe(iluminacion: string | null): string | null {
  if (!iluminacion) return null
  const t = slug(iluminacion)
  if (/lluv/.test(t)) return "lluvia"
  if (/niebla|neblina/.test(t)) return "niebla"
  if (/nieve/.test(t)) return "nieve"
  if (/grani/.test(t)) return "granizo"
  return null
}

/** Separa "Calle, Municipio, Estado, CP, País" en partes. Si no se puede saber, devuelve null. */
function partesUbicacion(q: string | undefined) {
  const partes = (q ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !/^\d{4,6}$/.test(p))
  const n = partes.length
  return {
    nombre: partes[0] ?? null,
    municipio: n >= 3 ? partes[n - 3] : n === 2 ? partes[1] : null,
    estado: n >= 3 ? partes[n - 2] : null,
    pais: n >= 3 ? partes[n - 1] : null,
  }
}

/** "00:03.38" -> 3.38 s; "3.38" -> 3.38 s. */
function segundos(t: string | undefined): number | null {
  if (!t) return null
  const m = t.trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/)
  if (!m) return null
  const v = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2].replace(",", "."))
  return Number.isFinite(v) ? v : null
}

const norm360 = (g: number) => ((g % 360) + 360) % 360

/** Interpolación por el camino angular más corto. */
function mezclaAngulo(a: number, b: number, t: number) {
  const d = ((((b - a) % 360) + 540) % 360) - 180
  return norm360(a + d * t)
}

const cuaternionY = (grados: number) => ({
  x: 0,
  y: r(Math.sin(rad(grados) / 2), 4),
  z: 0,
  w: r(Math.cos(rad(grados) / 2), 4),
})

/** Velocidad como vector en el plano (X = Este, Z = Norte) a partir del rumbo. */
const velocidadVector = (kmh: number, rumboGrados: number) => ({
  x: r((kmh / 3.6) * Math.sin(rad(rumboGrados))),
  y: 0,
  z: r((kmh / 3.6) * Math.cos(rad(rumboGrados))),
})

export function buildUnitySimulation(input: UnitySimulationInput) {
  const iv = input.interview
  const e = iv.estado
  const ids = Array.from(
    new Set([...Object.keys(input.vehicles), ...Object.keys(iv.vehiculos)]),
  ).sort()

  // --- Datos para Unity (origen = punto de impacto) ---
  const imp = input.impact
  const aUnity = (p: Punto) => ({ x: r(p.x - imp.x), y: 0, z: r(p.y - imp.y) })
  const participa = (id: string) => (input.impactVehicles ? input.impactVehicles.includes(id) : true)
  const velocidadDe = (id: string): number | null => {
    const ve = numero(e, `velocidad_${id}_kmh`)
    if (ve !== null) return ve
    const vm = input.vehicles[id]?.speed
    return typeof vm === "number" && Number.isFinite(vm) ? vm : null
  }
  const distAImpacto = (id: string) => {
    const v = input.vehicles[id]
    return v ? Math.hypot(v.x - imp.x, v.y - imp.y) : 0
  }
  // Tiempo de impacto: el del asistente (p. ej. "00:03.38"); si no hay, el del vehículo que más tarda en llegar.
  const llegadas = ids
    .filter((id) => input.vehicles[id] && participa(id))
    .map((id) => {
      const vel = velocidadDe(id)
      return vel && vel > 0 ? distAImpacto(id) / (vel / 3.6) : 0
    })
  const tImpacto = r(segundos(input.impactTime) ?? Math.max(0, ...llegadas))
  const frame = (t: number) => Math.round(t * FPS)

  function datosUnity(id: string) {
    const v = input.vehicles[id]
    if (!v) return {}
    const ficha = FICHA_VEHICULO[variante(v.type)]
    const vel = velocidadDe(id)
    const interviene = participa(id)
    const capturado = norm360(v.rotation)
    const haciaImpacto =
      interviene && distAImpacto(id) > 0.01
        ? norm360((Math.atan2(imp.x - v.x, imp.y - v.y) * 180) / Math.PI)
        : capturado
    const rumboIni = r(haciaImpacto, 1)
    const posIni = aUnity(v)
    const rot = (y: number) => ({ x: 0, y: r(y, 1), z: 0 })

    const llegada = vel && vel > 0 ? distAImpacto(id) / (vel / 3.6) : 0
    const t0 = Math.max(0, r(tImpacto - llegada))
    const ajustado = tImpacto - llegada < -0.005

    const kf = (
      fase: string,
      t: number,
      pos: { x: number; y: number; z: number },
      yaw: number,
      kmh: number | null,
      extra: Record<string, unknown> = {},
    ) => ({
      frame: frame(t),
      tiempo_s: r(t),
      fase,
      es_posicion_inicial: fase === "aproximacion",
      posicion: pos,
      rotacion_grados: rot(yaw),
      rotacion_quaternion: cuaternionY(yaw),
      velocidad_kmh: kmh === null ? null : r(kmh, 1),
      velocidad_ms: kmh === null ? null : velocidadVector(kmh, rumboIni),
      ...extra,
    })

    const keyframes: Array<ReturnType<typeof kf>> = [
      kf("aproximacion", t0, posIni, rumboIni, vel, ajustado ? { tiempo_ajustado: true } : {}),
    ]
    if (interviene) {
      keyframes.push(kf("impacto_inicial", tImpacto, { x: 0, y: 0, z: 0 }, rumboIni, vel))
      if (v.postImpactOffset) {
        const fin = aUnity(v.postImpactOffset)
        const rotFin = norm360(v.postImpactOffset.rotation)
        const velPost = vel === null ? null : vel * 0.4
        const tPos = r(tImpacto + 0.18)
        const dFin = Math.hypot(fin.x, fin.z)
        const vPostMs = velPost ? velPost / 3.6 : 0
        const tFin = r(tPos + (vPostMs > 0 ? Math.max(1, (2 * dFin) / vPostMs) : 1.5))
        keyframes.push(
          kf(
            "rotacion_poscolision",
            tPos,
            { x: r(fin.x / 2), y: 0, z: r(fin.z / 2) },
            mezclaAngulo(rumboIni, rotFin, 0.5),
            velPost,
            { estimado: true },
          ),
          kf("detencion_posicion_final", tFin, fin, rotFin, 0),
        )
      }
    }

    return {
      id_unity: `vehiculo_${id.replace(/\D/g, "") || id.toLowerCase()}`,
      etiqueta: id,
      categoria: ficha.categoria,
      direccion_cardinal_capturada: v.direction ?? null,
      rumbo_capturado_grados: r(capturado, 1),
      rumbo_recalculado_hacia_impacto: interviene && Math.abs(haciaImpacto - capturado) > 1,
      transform_inicial: { posicion: posIni, rotacion_grados: rot(rumboIni), escala: { x: r(v.scale ?? 1), y: r(v.scale ?? 1), z: r(v.scale ?? 1) } },
      dimensiones_m: { largo: ficha.largo, ancho: ficha.ancho, alto: ficha.alto },
      dimensiones_estimadas: true,
      masa_kg: ficha.masa,
      masa_estimada: true,
      velocidad_inicial_kmh: vel,
      keyframes,
    }
  }

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
      ...datosUnity(id),
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

  // --- Elementos estáticos (evidencias y objetos del mapa) ---
  const elementosEstaticos = [
    ...input.evidence.map((ev) => ({
      id: `evidencia_${ev.label}`,
      tipo: "indicio",
      descripcion: `Indicio ${ev.label}`,
      transform: {
        posicion: aUnity(ev),
        rotacion_grados: { x: 0, y: 0, z: 0 },
        escala: { x: 0.3, y: 0.3, z: 0.3 },
      },
      collider: { tipo: "SphereCollider", radio: 0.15 },
    })),
    ...input.droppedItems.map((o) => {
      const esSenal = /se(ñ|n)al|sem(á|a)foro|\balto\b|ceda|poste/i.test(o.label)
      const esVehiculo = o.kind === "vehicle" || o.kind === "static-vehicle"
      const ficha = FICHA_VEHICULO[variante(o.label)]
      const k = o.scale || 1
      return {
        id: o.id,
        tipo: esSenal ? "senalizacion" : esVehiculo ? "vehiculo_estatico" : o.kind === "object" ? "objeto" : o.kind,
        descripcion: o.label,
        transform: {
          posicion: aUnity(o),
          rotacion_grados: { x: 0, y: rumbo(o.rotation) ?? 0, z: 0 },
          escala: esSenal ? { x: r(0.4 * k), y: r(3 * k), z: r(0.4 * k) } : { x: r(k), y: r(k), z: r(k) },
        },
        collider: esSenal
          ? { tipo: "CylinderCollider", radio: 0.2, altura: 3 }
          : esVehiculo
            ? { tipo: "BoxCollider", tamano: { x: ficha.ancho, y: ficha.alto, z: ficha.largo } }
            : { tipo: "BoxCollider", tamano: { x: 1, y: 1, z: 1 } },
      }
    }),
  ]

  // --- Registro de impactos ---
  const registroImpactos = [
    {
      id_impacto: "colision_01",
      tiempo_impacto_s: tImpacto,
      tipo_colision: TIPO_COLISION[iv.modalidad] ?? iv.modalidad,
      punto_contacto: { x: 0, y: 0.5, z: 0 },
      participantes: ids
        .filter((id) => input.vehicles[id] && participa(id))
        .map((id) => ({
          id: `vehiculo_${id.replace(/\D/g, "") || id.toLowerCase()}`,
          etiqueta: id,
          zona_afectada: input.vehicles[id]?.impactZone ? slug(input.vehicles[id].impactZone as string) : null,
        })),
      energia_absorbida_joules: null,
      energia_estimada: true,
    },
  ]

  const ubic = partesUbicacion(input.locationQuery)
  const sup = superficieInfo(texto(e, "superficie"))

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
      version: UNITY_FORMAT_VERSION,
      expediente: input.caseId,
      fecha_creacion: new Date().toISOString(),
      demo: false,
      aviso:
        "Posiciones, rumbos, velocidades y posición final salen del expediente. Masas, dimensiones, mu, tiempos post-impacto y energía son ESTIMADOS (marcados con *_estimad*/estimado).",
      unidades: {
        posicion: "metros",
        escala: "multiplicador (1 = tamaño original del prefab)",
        rotacion: "grados",
        tiempo: "segundos",
        velocidad: "km/h y m/s",
      },
      sistema_referencia: {
        motor: "Unity",
        regla: "Left-Handed",
        X: "Este",
        Y: "Arriba",
        Z: "Norte",
        origen: "punto de impacto (0,0,0)",
        rotacion_y: "rumbo en grados desde el Norte, sentido horario",
        nota: "Los campos 'transform_inicial', 'keyframes', 'elementos_estaticos' y 'registro_impactos' usan este sistema. 'posicion_inicial', 'trayectoria' y 'posicion_final' siguen en metros respecto al ancla (ver sistema_coordenadas).",
      },
      fps: FPS,
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
      nombre: ubic.nombre,
      municipio: ubic.municipio,
      estado: ubic.estado,
      pais: ubic.pais,
      origen_geografico: {
        latitud: input.anchor.lat,
        longitud: input.anchor.lng,
        nota: "Solo referencia para ubicar el origen en el mapa; Unity usa posicion en metros.",
      },
      condiciones: {
        clima: climaDe(texto(e, "iluminacion")),
        superficie: sup.superficie,
        coeficiente_friccion_mu: sup.mu,
        mu_estimado: sup.mu !== null,
      },
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
    elementos_estaticos: elementosEstaticos,
    registro_impactos: registroImpactos,
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
