import { useState, type ReactNode } from "react"
import AssistantHeader from "./AssistantHeader"
import CaseProgress from "./CaseProgress"
import ChatMessageList from "./ChatMessageList"
import QuickReplies from "./QuickReplies"
import SelectedElementCard from "./SelectedElementCard"
import ChatInput from "./ChatInput"
import InterviewChat from "./InterviewChat"
import { useAssistantChat } from "../../hooks/useAssistantChat"
import type { useWizard } from "../../hooks/useWizard"
import type { InterviewController } from "../../hooks/useInterview"
import { indexToStep, stepToIndex } from "../../lib/wizardMachine"

export default function AssistantPanel({
  context,
  onShowProperties,
  onAttachFile,
  wizard,
  wizardContent,
  interview,
  onExportUnitySimulation,
}: {
  context?: Record<string, unknown>
  onShowProperties?: () => void
  onAttachFile?: (filename: string) => void
  wizard?: ReturnType<typeof useWizard>
  wizardContent?: ReactNode
  /** Entrevista con el modelo de Ollama. Si se pasa, el panel muestra la pestaña "Entrevista IA". */
  interview?: InterviewController
  /** Descarga el JSON de simulación para Unity al terminar la entrevista. */
  onExportUnitySimulation?: () => void
}) {
  const {
    messages,
    isTyping,
    chatText,
    setChatText,
    quickReplies,
    selectedElement,
    sendMessage,
    clearChat,
  } = useAssistantChat(context)
  const [tab, setTab] = useState<"wizard" | "interview">("wizard")
  const showInterview = Boolean(interview) && tab === "interview"

  const handleClear = () => {
    if (showInterview && interview) {
      if (window.confirm("¿Reiniciar la entrevista? Se borrarán las respuestas de este expediente.")) {
        void interview.reset()
      }
      return
    }
    if (wizard) wizard.restartWizard()
    else clearChat()
  }

  return (
    <aside className={`assistant-pane ${interview ? "has-tabs" : ""}`}>
      <AssistantHeader
        onClearChat={handleClear}
        onShowProperties={onShowProperties || (() => {})}
      />
      {interview && (
        <div className="assistant-tabs" role="tablist" aria-label="Modo del asistente">
          <button
            aria-selected={tab === "wizard"}
            className={tab === "wizard" ? "is-active" : ""}
            onClick={() => setTab("wizard")}
            role="tab"
            type="button"
          >
            Reconstrucción
          </button>
          <button
            aria-selected={tab === "interview"}
            className={tab === "interview" ? "is-active" : ""}
            onClick={() => setTab("interview")}
            role="tab"
            type="button"
          >
            Entrevista IA
            {interview.interview && !interview.interview.done && (
              <small>{interview.interview.progress}%</small>
            )}
          </button>
        </div>
      )}
      {/* Con pestañas, el contenido va en un solo contenedor flexible para no romper la cuadrícula del panel. */}
      <div className={interview ? "assistant-body" : "assistant-body-passthrough"}>
      {showInterview && interview ? (
        <InterviewChat
          controller={interview}
          onExportUnity={onExportUnitySimulation}
          vehicles={context?.vehicles as Record<string, { type?: string; model?: string }>}
        />
      ) : (
        <>
          <CaseProgress
            progress={wizard?.progress}
            activeStepIndex={wizard?.activeSceneIndex}
            unlockedIndices={
              wizard ? wizard.wizardState.unlockedSteps.map(stepToIndex) : [0]
            }
            onSelectStepIndex={
              wizard ? (idx) => wizard.goToStep(indexToStep(idx)) : undefined
            }
          />
          {wizardContent ? (
            <div className="conversation wizard-conversation">
              {wizardContent}
            </div>
          ) : (
            <>
              <ChatMessageList messages={messages}>
                <QuickReplies
                  disabled={isTyping}
                  onSelect={(option) => sendMessage(option)}
                  options={quickReplies}
                />
                <SelectedElementCard stats={selectedElement} />
              </ChatMessageList>
              <ChatInput
                disabled={isTyping}
                onAttachFile={onAttachFile}
                onChange={setChatText}
                onSend={() => sendMessage()}
                value={chatText}
              />
            </>
          )}
        </>
      )}
      </div>
    </aside>
  )
}
