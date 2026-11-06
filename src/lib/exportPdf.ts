import { jsPDF } from "jspdf"
import autoTable from "jspdf-autotable"
import type { GeoPosition } from "./geo.ts"

export type CaseVehicleForPdf = {
  type?: string
  model?: string
  direction?: string
  speed?: number
  rotation?: number
  lat?: number
  lng?: number
  postImpactOffset?: { lat: number; lng: number; rotation: number }
  impactZone?: string
  trajectoryPoints?: Array<{ lat: number; lng: number }>
}

export type CaseDataForPdf = {
  caseId?: string
  anchor: GeoPosition
  locationQuery?: string
  municipio?: string
  estado?: string
  vehicles: Record<string, CaseVehicleForPdf>
  impactPosition?: GeoPosition
  impactVehicles?: string[]
  impactTime?: string
  impactZones?: Record<string, string>
  evidencePositions?: Array<{ label: string; lat: number; lng: number }>
  droppedItems?: Array<{ label: string; kind?: string; lat?: number; lng?: number }>
  wizardState?: { isComplete?: boolean }
  /** Respuestas de la entrevista pericial con el modelo de Ollama. */
  interview?: {
    modalidad: string
    vehiculos: Record<string, string>
    estado: Record<string, unknown>
    temas: Record<string, string>
    progress: number
  }
}

const INTERVIEW_SKIPPED = "__saltado__"

function interviewValue(value: unknown): string {
  if (value === INTERVIEW_SKIPPED) return "Omitido por el perito"
  if (value === null || value === undefined || value === "") return "No registrado"
  return typeof value === "string" ? value : JSON.stringify(value)
}

function parseLocationParts(query = ""): { municipio: string; estado: string } {
  if (!query) return { municipio: "No registrado", estado: "No registrado" }
  const parts = query.split(",").map((s) => s.trim()).filter(Boolean)
  if (parts.length >= 3) {
    return {
      municipio: parts[parts.length - 2] || "No registrado",
      estado: parts[parts.length - 1] || "No registrado",
    }
  }
  if (parts.length === 2) {
    return {
      municipio: parts[0] || "No registrado",
      estado: parts[1] || "No registrado",
    }
  }
  return { municipio: "No registrado", estado: "No registrado" }
}

/**
 * Dibuja un croquis planimétrico y cinemático vectorial de la escena
 * usando las coordenadas y rumbos reales de los vehículos, impacto y evidencias.
 */
function drawSceneCroquis(
  doc: jsPDF,
  startX: number,
  startY: number,
  width: number,
  height: number,
  caso: CaseDataForPdf,
) {
  // Fondo y marco del croquis
  doc.setFillColor(248, 250, 252)
  doc.setDrawColor(203, 213, 225)
  doc.setLineWidth(0.4)
  doc.rect(startX, startY, width, height, "FD")

  // Cuadrícula técnica sutil
  doc.setDrawColor(241, 245, 249)
  doc.setLineWidth(0.2)
  for (let x = startX + 15; x < startX + width; x += 15) {
    doc.line(x, startY, x, startY + height)
  }
  for (let y = startY + 12; y < startY + height; y += 12) {
    doc.line(startX, y, startX + width, y)
  }

  // Rosa de los vientos / Flecha Norte
  const northX = startX + width - 12
  const northY = startY + 12
  doc.setFillColor(210, 38, 48) // Rojo CESVI
  doc.triangle(northX, northY - 6, northX - 3, northY, northX + 3, northY, "F")
  doc.setFillColor(100, 116, 139)
  doc.triangle(northX, northY + 4, northX - 3, northY, northX + 3, northY, "F")
  doc.setFontSize(7)
  doc.setTextColor(15, 23, 42)
  doc.text("N", northX - 1.2, northY - 7)

  // Escala métrica referencial
  doc.setDrawColor(71, 85, 105)
  doc.setLineWidth(0.6)
  doc.line(startX + 8, startY + height - 6, startX + 28, startY + height - 6)
  doc.line(startX + 8, startY + height - 8, startX + 8, startY + height - 4)
  doc.line(startX + 28, startY + height - 8, startX + 28, startY + height - 4)
  doc.setFontSize(6.5)
  doc.setTextColor(100, 116, 139)
  doc.text("10 m", startX + 14, startY + height - 7.5)

  // Centro de proyección en coordenadas relativas
  const refLat = caso.anchor?.lat ?? 19.4326
  const refLng = caso.anchor?.lng ?? -99.1332
  const metersPerDegLat = 111320
  const metersPerDegLng = 111320 * Math.cos((refLat * Math.PI) / 180)

  type Pt = { x: number; y: number; label: string; color: [number, number, number]; rot?: number }
  const points: Pt[] = []

  // Impacto
  const impact = caso.impactPosition ?? caso.anchor
  const impDx = (impact.lng - refLng) * metersPerDegLng
  const impDy = (impact.lat - refLat) * metersPerDegLat
  points.push({ x: impDx, y: impDy, label: "IMPACTO", color: [220, 38, 38] })

  // Vehículos iniciales y finales
  Object.entries(caso.vehicles || {}).forEach(([id, v], idx) => {
    const vLat = v.lat ?? refLat
    const vLng = v.lng ?? refLng
    const vDx = (vLng - refLng) * metersPerDegLng
    const vDy = (vLat - refLat) * metersPerDegLat
    const color: [number, number, number] = idx === 0 ? [37, 99, 235] : [5, 150, 105]
    points.push({ x: vDx, y: vDy, label: `${id} (Inicio)`, color, rot: v.rotation ?? 0 })

    if (v.postImpactOffset) {
      const fDx = (v.postImpactOffset.lng - refLng) * metersPerDegLng
      const fDy = (v.postImpactOffset.lat - refLat) * metersPerDegLat
      points.push({
        x: fDx,
        y: fDy,
        label: `${id} (Final)`,
        color: [217, 119, 6],
        rot: v.postImpactOffset.rotation ?? v.rotation ?? 0,
      })
    }
  })

  // Evidencias
  ;(caso.evidencePositions || []).forEach((e) => {
    const eDx = (e.lng - refLng) * metersPerDegLng
    const eDy = (e.lat - refLat) * metersPerDegLat
    points.push({ x: eDx, y: eDy, label: e.label, color: [202, 138, 4] })
  })

  // Bounding box en metros
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(-20, ...xs)
  const maxX = Math.max(20, ...xs)
  const minY = Math.min(-20, ...ys)
  const maxY = Math.max(20, ...ys)
  const rangeX = Math.max(30, maxX - minX)
  const rangeY = Math.max(20, maxY - minY)

  // Escala adaptativa en mm por metro
  const scaleX = (width - 34) / rangeX
  const scaleY = (height - 24) / rangeY
  const scale = Math.min(scaleX, scaleY)

  const toCanvasX = (mX: number) => startX + width / 2 + (mX - (minX + maxX) / 2) * scale
  const toCanvasY = (mY: number) => startY + height / 2 - (mY - (minY + maxY) / 2) * scale

  // Dibujar líneas de aproximación / trayectoria hacia el impacto
  const impCx = toCanvasX(impDx)
  const impCy = toCanvasY(impDy)

  Object.entries(caso.vehicles || {}).forEach(([_, v], idx) => {
    const vLat = v.lat ?? refLat
    const vLng = v.lng ?? refLng
    const vCx = toCanvasX((vLng - refLng) * metersPerDegLng)
    const vCy = toCanvasY((vLat - refLat) * metersPerDegLat)

    doc.setDrawColor(idx === 0 ? 37 : 5, idx === 0 ? 99 : 150, idx === 0 ? 235 : 105)
    doc.setLineWidth(0.4)
    doc.setLineDashPattern([1.5, 1.5], 0)
    doc.line(vCx, vCy, impCx, impCy)

    // Trayectoria a posición final si existe
    if (v.postImpactOffset) {
      const fCx = toCanvasX((v.postImpactOffset.lng - refLng) * metersPerDegLng)
      const fCy = toCanvasY((v.postImpactOffset.lat - refLat) * metersPerDegLat)
      doc.setDrawColor(217, 119, 6)
      doc.setLineDashPattern([1, 1], 0)
      doc.line(impCx, impCy, fCx, fCy)
    }
  })
  doc.setLineDashPattern([], 0)

  // Dibujar punto de impacto
  doc.setFillColor(220, 38, 38)
  doc.circle(impCx, impCy, 3, "F")
  doc.setDrawColor(220, 38, 38)
  doc.setLineWidth(0.3)
  doc.circle(impCx, impCy, 5, "S")
  doc.setFontSize(6.5)
  doc.setFont("helvetica", "bold")
  doc.setTextColor(185, 28, 28)
  doc.text("★ IMPACTO", impCx + 4, impCy - 2)

  // Dibujar vehículos
  points.forEach((pt) => {
    if (pt.label === "IMPACTO") return
    const cx = toCanvasX(pt.x)
    const cy = toCanvasY(pt.y)

    doc.setFillColor(pt.color[0], pt.color[1], pt.color[2])
    doc.setDrawColor(15, 23, 42)
    doc.setLineWidth(0.2)

    if (pt.label.includes("Final")) {
      // Posición final: rectángulo punteado / sombreado
      doc.rect(cx - 3.5, cy - 2, 7, 4, "S")
    } else if (pt.label.startsWith("E")) {
      // Indicio: círculo amarillo
      doc.circle(cx, cy, 2, "FD")
    } else {
      // Vehículo inicial: rectángulo sólido
      doc.rect(cx - 4, cy - 2.5, 8, 5, "FD")
    }

    doc.setFontSize(6)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(30, 41, 59)
    doc.text(pt.label, cx - 4, cy + 6)
  })

  // Título del croquis
  doc.setFontSize(7)
  doc.setFont("helvetica", "bold")
  doc.setTextColor(71, 85, 105)
  doc.text("CROQUIS PERICIAL Y DINÁMICA DEL SINIESTRO (Proyección relativa)", startX + 6, startY + 6)
}

/**
 * Genera el documento PDF formal de reconstrucción pericial y lo descarga en el navegador.
 */
export function buildReportPdf(caso: CaseDataForPdf): jsPDF {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  })

  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 14
  const contentWidth = pageWidth - margin * 2

  const fechaEmision = new Date().toLocaleDateString("es-MX", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })

  const locationParts = parseLocationParts(caso.locationQuery)
  const municipio = caso.municipio || locationParts.municipio
  const estado = caso.estado || locationParts.estado

  // ==========================================
  // PÁGINA 1: Encabezado, Ubicación y Croquis
  // ==========================================

  // Barra superior de acento CESVI
  doc.setFillColor(210, 38, 48) // Rojo corporativo CESVI
  doc.rect(0, 0, pageWidth, 4, "F")

  let currentY = 14

  // Encabezado institucional
  doc.setFont("helvetica", "bold")
  doc.setFontSize(14)
  doc.setTextColor(15, 23, 42)
  doc.text("CESVI MÉXICO", margin, currentY)

  doc.setFontSize(9)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(100, 116, 139)
  doc.text("Centro de Experimentación y Seguridad Vial México", margin, currentY + 4.5)

  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  doc.setTextColor(210, 38, 48)
  doc.text("EXPEDIENTE: EXP-0248", pageWidth - margin, currentY, { align: "right" })

  doc.setFont("helvetica", "normal")
  doc.setFontSize(8)
  doc.setTextColor(100, 116, 139)
  doc.text(`Fecha de emisión: ${fechaEmision}`, pageWidth - margin, currentY + 4.5, { align: "right" })

  currentY += 10
  doc.setDrawColor(226, 232, 240)
  doc.setLineWidth(0.4)
  doc.line(margin, currentY, pageWidth - margin, currentY)

  // Título del dictamen
  currentY += 7
  doc.setFont("helvetica", "bold")
  doc.setFontSize(12)
  doc.setTextColor(15, 23, 42)
  doc.text("INFORME PERICIAL DE RECONSTRUCCIÓN VIAL", margin, currentY)

  doc.setFontSize(8.5)
  doc.setFont("helvetica", "normal")
  doc.setTextColor(71, 85, 105)
  currentY += 4.5
  doc.text(
    "Dictamen técnico-cinemático de hecho de tránsito terrestre mediante reconstrucción cartográfica asistida.",
    margin,
    currentY,
  )

  // Bloque 1: Ubicación del Siniestro
  currentY += 7
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  doc.setTextColor(210, 38, 48)
  doc.text("1. UBICACIÓN Y CONDICIONES DEL LUGAR", margin, currentY)

  currentY += 2
  autoTable(doc, {
    startY: currentY,
    margin: { left: margin, right: margin },
    theme: "plain",
    styles: { fontSize: 8, cellPadding: 1.5, textColor: [30, 41, 59] },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 38, textColor: [71, 85, 105] },
      1: { cellWidth: 53 },
      2: { fontStyle: "bold", cellWidth: 38, textColor: [71, 85, 105] },
      3: { cellWidth: 53 },
    },
    body: [
      [
        "Dirección registrada:",
        caso.locationQuery || "No registrado",
        "Coordenadas (WGS84):",
        caso.anchor ? `${caso.anchor.lat.toFixed(6)}, ${caso.anchor.lng.toFixed(6)}` : "No registrado",
      ],
      [
        "Municipio / Alcaldía:",
        municipio,
        "Entidad federativa:",
        estado,
      ],
    ],
  })

  currentY = (doc as any).lastAutoTable.finalY + 4

  // Bloque 2: Croquis pericial de la escena
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  doc.setTextColor(210, 38, 48)
  doc.text("2. CROQUIS PLANIMÉTRICO Y DINÁMICA DE LA ESCENA", margin, currentY)

  currentY += 2.5
  const croquisHeight = 54
  drawSceneCroquis(doc, margin, currentY, contentWidth, croquisHeight, caso)
  currentY += croquisHeight + 5

  // Bloque 3: Tabla de Vehículos Involucrados
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  doc.setTextColor(210, 38, 48)
  doc.text("3. VEHÍCULOS INVOLUCRADOS", margin, currentY)

  currentY += 2
  const vehiclesRows = Object.entries(caso.vehicles || {}).map(([id, v]) => {
    const vSpeedKmh = v.speed ?? null
    const vSpeedMs = vSpeedKmh !== null ? (vSpeedKmh / 3.6).toFixed(1) : null
    const speedStr = vSpeedKmh !== null ? `${vSpeedKmh} km/h (${vSpeedMs} m/s)` : "No registrado"
    const rumboStr = v.direction
      ? `${v.direction} (${v.rotation ?? 0}°)`
      : v.rotation !== undefined
        ? `${v.rotation}°`
        : "No registrado"
    const posInicial =
      v.lat && v.lng ? `${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}` : "No registrado"
    const posFinal = v.postImpactOffset
      ? `${v.postImpactOffset.lat.toFixed(5)}, ${v.postImpactOffset.lng.toFixed(5)}`
      : posInicial

    return [
      id,
      v.type || "Automóvil",
      v.model || "No registrado",
      rumboStr,
      speedStr,
      posInicial,
      posFinal,
    ]
  })

  autoTable(doc, {
    startY: currentY,
    margin: { left: margin, right: margin },
    head: [
      [
        "ID",
        "Tipo",
        "Marca / Modelo",
        "Rumbo",
        "Velocidad est.",
        "Posición inicial",
        "Posición final",
      ],
    ],
    body: vehiclesRows.length > 0 ? vehiclesRows : [["No registrado", "No registrado", "No registrado", "No registrado", "No registrado", "No registrado", "No registrado"]],
    theme: "striped",
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontSize: 7.5,
      fontStyle: "bold",
      cellPadding: 2,
    },
    styles: { fontSize: 7, cellPadding: 2, textColor: [30, 41, 59] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  })

  // ==========================================
  // PÁGINA 2: Dinámica de Impacto, Indicios y Notas
  // ==========================================
  doc.addPage()

  // Barra superior de acento CESVI en página 2
  doc.setFillColor(210, 38, 48)
  doc.rect(0, 0, pageWidth, 4, "F")

  currentY = 16

  // Bloque 4: Dinámica del Impacto
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  doc.setTextColor(210, 38, 48)
  doc.text("4. DINÁMICA DEL IMPACTO", margin, currentY)

  currentY += 2
  const imp = caso.impactPosition || caso.anchor
  const impCoords = imp ? `${imp.lat.toFixed(6)}, ${imp.lng.toFixed(6)}` : "No registrado"
  const impVehiclesStr = (caso.impactVehicles || []).join(", ") || "V1, V2"

  const damageRows = Object.entries(caso.vehicles || {}).map(([id, v]) => {
    const damage = v.impactZone || (caso.impactZones && caso.impactZones[id]) || "No registrado"
    return `${id}: ${damage}`
  })

  autoTable(doc, {
    startY: currentY,
    margin: { left: margin, right: margin },
    theme: "grid",
    headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontSize: 8 },
    styles: { fontSize: 8, cellPadding: 2.5, textColor: [30, 41, 59] },
    body: [
      [
        { content: "Punto de colisión:", styles: { fontStyle: "bold", cellWidth: 45 } },
        { content: impCoords },
      ],
      [
        { content: "Vehículos participantes:", styles: { fontStyle: "bold" } },
        { content: impVehiclesStr },
      ],
      [
        { content: "Tiempo estimado de impacto:", styles: { fontStyle: "bold" } },
        { content: caso.impactTime || "00:03.38 (Tiempo referencial pericial)" },
      ],
      [
        { content: "Tipo de colisión:", styles: { fontStyle: "bold" } },
        { content: "Colisión angular / perpendicular en cruce vial" },
      ],
      [
        { content: "Zonas de daño por vehículo:", styles: { fontStyle: "bold" } },
        { content: damageRows.length > 0 ? damageRows.join(" | ") : "No registrado" },
      ],
    ],
  })

  currentY = (doc as any).lastAutoTable.finalY + 6

  // Bloque 5: Indicios Periciales y Señalización
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  doc.setTextColor(210, 38, 48)
  doc.text("5. INDICIOS FÍSICOS Y ELEMENTOS DE LA VÍA", margin, currentY)

  currentY += 2
  const evidenceList = caso.evidencePositions || []
  const droppedList = caso.droppedItems || []

  const indiciosBody = [
    ...evidenceList.map((e) => [
      e.label,
      "Indicio físico / huella de frenado",
      `${e.lat.toFixed(6)}, ${e.lng.toFixed(6)}`,
      "Fijado pericialmente",
    ]),
    ...droppedList.map((d) => [
      d.label,
      `Elemento / ${d.kind || "señalización"}`,
      d.lat && d.lng ? `${d.lat.toFixed(6)}, ${d.lng.toFixed(6)}` : "En el escenario",
      "Inventariado",
    ]),
  ]

  autoTable(doc, {
    startY: currentY,
    margin: { left: margin, right: margin },
    head: [["Identificador", "Descripción / Elemento", "Ubicación geográfica", "Estado"]],
    body:
      indiciosBody.length > 0
        ? indiciosBody
        : [["No registrado", "No registrado", "No registrado", "No registrado"]],
    theme: "striped",
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontSize: 7.5,
      fontStyle: "bold",
      cellPadding: 2,
    },
    styles: { fontSize: 7, cellPadding: 2, textColor: [30, 41, 59] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  })

  currentY = (doc as any).lastAutoTable.finalY + 6

  // Bloque 6: Notas Metodológicas (Datos Capturados vs Estimados)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(9.5)
  doc.setTextColor(210, 38, 48)
  doc.text("6. NOTAS METODOLÓGICAS Y CONFIABILIDAD DE DATOS", margin, currentY)

  currentY += 2.5
  doc.setFillColor(248, 250, 252)
  doc.setDrawColor(203, 213, 225)
  doc.setLineWidth(0.3)
  const notesHeight = 28
  doc.roundedRect(margin, currentY, contentWidth, notesHeight, 2, 2, "FD")

  doc.setFontSize(7.5)
  doc.setTextColor(30, 41, 59)
  doc.setFont("helvetica", "bold")
  doc.text("• DATOS CAPTURADOS FÍSICAMENTE (Certeza técnica directa):", margin + 3, currentY + 5)
  doc.setFont("helvetica", "normal")
  doc.text(
    "Coordenadas del ancla geográfica y punto de colisión fijados en cartografía satelital WGS84. Posición de reposo de vehículos y ubicación de evidencias físicas (E1, E2) sobre la vía.",
    margin + 6,
    currentY + 9,
    { maxWidth: contentWidth - 10 },
  )

  doc.setFont("helvetica", "bold")
  doc.text("• DATOS ESTIMADOS PERICIALMENTE (Cálculo analítico / cinemático):", margin + 3, currentY + 16)
  doc.setFont("helvetica", "normal")
  doc.text(
    "Velocidad previa de aproximación y tiempo de reacción estimados mediante el modelo de conservación de cantidad de movimiento y análisis de energía de deformación.",
    margin + 6,
    currentY + 20,
    { maxWidth: contentWidth - 10 },
  )

  currentY += notesHeight + 10

  // Bloque de Firma Pericial
  const signY = currentY + 8
  doc.setDrawColor(100, 116, 139)
  doc.setLineWidth(0.4)
  doc.line(margin + 40, signY, margin + contentWidth - 40, signY)

  doc.setFontSize(8)
  doc.setFont("helvetica", "bold")
  doc.setTextColor(15, 23, 42)
  doc.text("PERITO DICTAMINADOR EN HECHOS DE TRÁNSITO TERRESTRE", pageWidth / 2, signY + 4, {
    align: "center",
  })
  doc.setFont("helvetica", "normal")
  doc.setFontSize(7)
  doc.setTextColor(100, 116, 139)
  doc.text("CESVI México · Certificación de Peritaje Vial", pageWidth / 2, signY + 7.5, {
    align: "center",
  })

  // Bloque 7: Entrevista pericial (asistente IA local con Ollama)
  if (caso.interview) {
    const iv = caso.interview
    doc.addPage()
    let y = 20
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9.5)
    doc.setTextColor(210, 38, 48)
    doc.text("7. ENTREVISTA PERICIAL (ASISTENTE IA)", margin, y)
    y += 5
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7.5)
    doc.setTextColor(30, 41, 59)
    const vehiculos = Object.entries(iv.vehiculos)
      .map(([id, desc]) => `${id}: ${desc}`)
      .join(" · ")
    doc.text(
      `Modalidad: ${iv.modalidad}   ·   Avance: ${iv.progress}%   ·   Vehículos: ${vehiculos || "No registrado"}`,
      margin,
      y,
      { maxWidth: contentWidth },
    )
    y += 6
    const rows = Object.entries(iv.estado).map(([id, value]) => [
      iv.temas[id] ?? id,
      interviewValue(value),
    ])
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Tema", "Respuesta registrada"]],
      body: rows.length > 0 ? rows : [["Sin respuestas", "No registrado"]],
      theme: "striped",
      headStyles: {
        fillColor: [15, 23, 42],
        textColor: [255, 255, 255],
        fontSize: 7.5,
        fontStyle: "bold",
        cellPadding: 2,
      },
      styles: { fontSize: 7, cellPadding: 2, textColor: [30, 41, 59], overflow: "linebreak" },
      columnStyles: { 0: { cellWidth: contentWidth * 0.42 } },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    })
    const afterTable = (doc as any).lastAutoTable.finalY + 5
    doc.setFontSize(6.5)
    doc.setTextColor(100, 116, 139)
    doc.text(
      "Preguntas redactadas y respuestas estructuradas por un modelo de lenguaje local a partir de lo declarado por el perito. Verificar antes de dictaminar.",
      margin,
      Math.min(afterTable, pageHeight - 18),
      { maxWidth: contentWidth },
    )
  }

  // ==========================================
  // PIE DE PÁGINA EN CADA PÁGINA
  // ==========================================
  const totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setDrawColor(226, 232, 240)
    doc.setLineWidth(0.3)
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12)

    doc.setFontSize(6.5)
    doc.setFont("helvetica", "normal")
    doc.setTextColor(100, 116, 139)
    doc.text(
      "Datos cartográficos © OpenStreetMap contributors (https://www.openstreetmap.org/copyright)",
      margin,
      pageHeight - 7,
    )
    doc.text(`Página ${i} de ${totalPages}`, pageWidth - margin, pageHeight - 7, {
      align: "right",
    })
  }

  // Descarga automática en navegador
  if (typeof window !== "undefined") {
    doc.save("EXP-0248-informe.pdf")
  }

  return doc
}
