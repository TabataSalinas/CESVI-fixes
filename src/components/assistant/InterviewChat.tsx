import { useEffect, useRef, useState } from "react"
import ChatMessage from "./ChatMessage"
import ChatInput from "./ChatInput"
import Button from "../ui/Button"
import type { InterviewController } from "../../hooks/useInterview"

type MapVehicleLike = { type?: string; model?: string }

const describeVehicle = (v?: MapVehicleLike) =>
  v ? [v.type, v.model].filter(Boolean).join(" ").trim() : ""

/** Entrevista pericial guiada por el modelo de Ollama (chatbot-service). */
export default function InterviewChat({
  controller,
  vehicles,
}: {
  controller: InterviewController
  vehicles?: Record<string, MapVehicleLike>
}) {
  const { status, interview, messages, busy, error, setError, refreshStatus, start, answer } =
    controller
  const [text, setText] = useState("")
  const [modalidad, setModalidad] = useState("")
  const [v1, setV1] = useState("")
  const [v2, setV2] = useState("")
  const endRef = useRef<HTMLDivElement>(null)

  // Propone la descripción de los vehículos que ya se registraron en el mapa (Escena 02).
  useEffect(() => {
    if (!v1) setV1(describeVehicle(vehicles?.V1))
    if (!v2) setV2(describeVehicle(vehicles?.V2))
    // Solo cuando cambian los vehículos del mapa; no pisar lo que el perito escribió.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [messages.length, busy])

  const send = async () => {
    if (busy || !text.trim()) return
    const value = text
    setText("")
    const ok = await answer(value)
    if (!ok) setText(value) // devolver el texto para poder reintentar
  }

  if (!status) {
    return <p className="interview-note">Comprobando el asistente local…</p>
  }

  if (!status.available) {
    return (
      <div className="interview-setup">
        <b>El asistente de Ollama no está disponible</b>
        <p>{status.hint || "No se pudo conectar con el modelo."}</p>
        <Button className="primary-button" onClick={() => void refreshStatus()}>
          Reintentar
        </Button>
      </div>
    )
  }

  if (!interview) {
    const vehiculos: Record<string, string> = { V1: v1.trim() || "vehículo 1" }
    if (v2.trim()) vehiculos.V2 = v2.trim()
    return (
      <div className="interview-setup">
        <b>Iniciar entrevista pericial</b>
        <p>
          Elige la modalidad del siniestro y describe los vehículos (marca, tipo, modelo y
          color). El asistente hará una pregunta por tema.
        </p>
        <label>
          <span>Modalidad</span>
          <select onChange={(e) => setModalidad(e.target.value)} value={modalidad}>
            <option value="">Selecciona…</option>
            {Object.entries(status.modalidades).map(([id, label]) => (
              <option key={id} value={id}>
                {label.split(" (")[0]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Vehículo V1</span>
          <input
            onChange={(e) => setV1(e.target.value)}
            placeholder="Ej. Nissan Versa sedán gris"
            value={v1}
          />
        </label>
        <label>
          <span>Vehículo V2 (opcional)</span>
          <input
            onChange={(e) => setV2(e.target.value)}
            placeholder="Ej. VW Jetta sedán negro"
            value={v2}
          />
        </label>
        {error && <p className="interview-error">{error}</p>}
        <Button
          className="primary-button"
          disabled={!modalidad || busy}
          onClick={() => void start(modalidad, vehiculos)}
        >
          {busy ? "Preparando la primera pregunta…" : "Iniciar entrevista"}
        </Button>
        {busy && (
          <small className="interview-note">
            La primera vez tarda más: Ollama está cargando el modelo en memoria.
          </small>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="conversation">
        <div className="interview-progress" aria-label="Avance de la entrevista">
          <span>
            Entrevista · {interview.answered}/{interview.total} temas
          </span>
          <b>{interview.progress}%</b>
          <div className="interview-progress-track">
            <span style={{ width: `${interview.progress}%` }} />
          </div>
        </div>
        {messages.map((m, i) => (
          <ChatMessage key={`${m.role}-${i}`} message={m} />
        ))}
        {busy && <ChatMessage message={{ role: "assistant", text: "Pensando…" }} />}
        {error && (
          <p className="interview-error" onClick={() => setError(null)}>
            {error}
          </p>
        )}
        {!interview.done && (
          <small className="interview-note">Escribe «saltar» para omitir un tema.</small>
        )}
        <div ref={endRef} />
      </div>
      {interview.done ? (
        <p className="interview-note interview-done">
          Entrevista completa. Las respuestas se incluyen en el informe PDF.
        </p>
      ) : (
        <ChatInput disabled={busy} onChange={setText} onSend={() => void send()} value={text} />
      )}
    </>
  )
}
