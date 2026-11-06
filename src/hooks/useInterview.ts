import { useCallback, useEffect, useState } from "react"
import {
  interviewApi,
  InterviewApiError,
  type InterviewState,
  type InterviewStatus,
  type InterviewTurn,
} from "../lib/interviewApi"

/**
 * Estado de la entrevista pericial con el modelo de Ollama.
 * Vive en App para que el informe PDF pueda incluir las respuestas.
 */
export function useInterview() {
  const [status, setStatus] = useState<InterviewStatus | null>(null)
  const [interview, setInterview] = useState<InterviewState | null>(null)
  // Conversación visible: la del servidor más el mensaje del perito mientras el modelo responde.
  const [messages, setMessages] = useState<InterviewTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      const next = await interviewApi.status()
      setStatus(next)
      return next
    } catch (err) {
      const next: InterviewStatus = {
        available: false,
        modalidades: {},
        hint: err instanceof Error ? err.message : undefined,
      }
      setStatus(next)
      return next
    }
  }, [])

  // Al abrir la página: comprobar el modelo y recuperar la entrevista en curso, si hay una.
  useEffect(() => {
    let active = true
    void (async () => {
      const current = await refreshStatus()
      if (!active || !current.available) return
      try {
        const state = await interviewApi.get()
        if (!active) return
        setInterview(state)
        setMessages(state.transcript)
      } catch (err) {
        // 404: todavía no hay entrevista para este expediente.
        if (!(err instanceof InterviewApiError && err.status === 404) && active) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      active = false
    }
  }, [refreshStatus])

  const start = useCallback(async (modalidad: string, vehiculos: Record<string, string>) => {
    setBusy(true)
    setError(null)
    try {
      const state = await interviewApi.start(modalidad, vehiculos)
      setInterview(state)
      setMessages(state.transcript)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  /** Devuelve false si falló, para que la UI conserve el texto y se pueda reintentar. */
  const answer = useCallback(async (respuesta: string) => {
    const text = respuesta.trim()
    if (!text) return true
    setBusy(true)
    setError(null)
    setMessages((current) => [...current, { role: "user", text }])
    try {
      const state = await interviewApi.answer(text)
      setInterview(state)
      setMessages(state.transcript)
      if (state.aviso) setError(state.aviso)
      return true
    } catch (err) {
      setMessages((current) => current.slice(0, -1))
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const reset = useCallback(async () => {
    setError(null)
    try {
      await interviewApi.reset()
      setInterview(null)
      setMessages([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  return { status, interview, messages, busy, error, setError, refreshStatus, start, answer, reset }
}

export type InterviewController = ReturnType<typeof useInterview>
