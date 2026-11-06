// Cliente de la entrevista pericial que corre en chatbot-service/server.py (modelo de Ollama).

export type InterviewTurn = { role: "user" | "assistant"; text: string }

export type InterviewState = {
  caseId: string
  modalidad: string
  vehiculos: Record<string, string>
  estado: Record<string, unknown>
  tema: string | null
  pregunta: string | null
  progress: number
  answered: number
  total: number
  done: boolean
  transcript: InterviewTurn[]
  /** Descripción legible de cada tema, por id. */
  temas: Record<string, string>
  /** Temas que el perito omitió o para los que no tenía información. */
  sinInformacion?: string[]
  aviso?: string
}

export type InterviewStatus = {
  available: boolean
  model?: string
  modalidades: Record<string, string>
  hint?: string
}

/** Valor que el servicio guarda cuando el perito escribe "saltar". */
export const INTERVIEW_SKIPPED = "__saltado__"

const BASE = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "")
const CASE_ID = import.meta.env.VITE_CASE_ID || "EXP-0248"

export class InterviewApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new InterviewApiError(
      "No hay conexión con el servidor de CESVI. Revisa que chatbot-service/server.py esté corriendo.",
      0,
    )
  }
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // Sin cuerpo JSON: se usa el mensaje genérico de abajo.
  }
  if (!response.ok) {
    const { error, hint } = (payload ?? {}) as { error?: string; hint?: string }
    throw new InterviewApiError(
      [error, hint].filter(Boolean).join(" ") || `El servidor respondió ${response.status}`,
      response.status,
    )
  }
  return payload as T
}

export const interviewApi = {
  caseId: CASE_ID,
  status: () => call<InterviewStatus>("/ai/status"),
  get: () => call<InterviewState>(`/ai/interview/${encodeURIComponent(CASE_ID)}`),
  start: (modalidad: string, vehiculos: Record<string, string>) =>
    call<InterviewState>("/ai/interview/start", { caseId: CASE_ID, modalidad, vehiculos }),
  answer: (respuesta: string) =>
    call<InterviewState>("/ai/interview/answer", { caseId: CASE_ID, respuesta }),
  reset: () => call<{ ok: boolean }>("/ai/interview/reset", { caseId: CASE_ID }),
}
