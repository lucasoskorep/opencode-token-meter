/** @jsxImportSource @opentui/solid */
/**
 * opencode-token-meter (TUI plugin)
 * -------------------------------------------------------------------------
 * Renders a tokens/second readout natively in the TUI, inline in the prompt's
 * status/meta row — the same status cluster as the model name and the
 * context% / "ctrl+p commands" hints (the `session_prompt_right` slot).
 *
 * How the rate is measured:
 *   The window is from the FIRST streamed token to the LAST streamed token of
 *   the current response — not from request start to completion. opencode's v2
 *   message model does not attach per-token timestamps to text/reasoning parts,
 *   so the plugin observes the stream and records the wall-clock time of the
 *   first and last content it sees. This excludes:
 *     - time-to-first-token (the wait before generation starts), and
 *     - the trailing finalization after the last token.
 *
 *   Idle / user-input gaps are excluded too: measurement is per generation step
 *   (one assistant message). Tool execution and permission/user prompts happen
 *   BETWEEN steps, so that idle time never falls inside the measured window.
 *
 *   Tokens:
 *     - On completion  -> EXACT count from real provider usage (output + reasoning).
 *     - While streaming -> estimated from streamed chars, calibrated from the
 *       last completed response's real tokens/char (never a fixed 4; 4 is only
 *       the cold-start fallback). Set liveEstimate=false to skip the estimate
 *       and show only progress until the exact value at finish.
 *
 * Registered via `.opencode/tui.json`. Options:
 *   slot          "session_prompt_right" (default, inline in prompt footer) | "app_bottom" (own line below prompt)
 *   liveEstimate  boolean, show estimated tok/s while streaming (default true)
 *   charsPerToken number, force a fixed estimate divisor; 0 = auto-calibrate (default 0)
 *   label         string, optional prefix shown before the readout
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js"

type Options = {
  slot?: "app_bottom" | "session_prompt_right"
  liveEstimate?: boolean
  charsPerToken?: number
  label?: string
}

// kind: "final" = exact real tokens; "live" = calibrated estimate; "raw" = no estimate, progress only
type Stat = { kind: "final" | "live" | "raw"; tps: number; tokens: number; chars: number; secs: number }

const FALLBACK_TOKENS_PER_CHAR = 1 / 4 // cold-start only, before any real usage is known
const MIN_WINDOW_SECONDS = 0.25 // ignore windows too short to yield a meaningful rate

const oneDp = (n: number) => (Math.round(n * 10) / 10).toFixed(1)
const int = (n: number) => Math.round(n).toLocaleString()

function streamedChars(parts: ReadonlyArray<Part>): number {
  let chars = 0
  for (const p of parts) {
    if ((p.type === "text" || p.type === "reasoning") && typeof (p as { text?: unknown }).text === "string") {
      chars += (p as { text: string }).text.length
    }
  }
  return chars
}

function generatedTokens(m: AssistantMessage): number {
  return (m.tokens?.output ?? 0) + (m.tokens?.reasoning ?? 0)
}

function Meter(props: {
  api: TuiPluginApi
  sessionID: () => string | undefined
  liveEstimate: boolean
  charsPerToken: number
  label?: string
  compact?: boolean
}) {
  const theme = () => props.api.theme.current

  const messages = createMemo<ReadonlyArray<AssistantMessage>>(() => {
    const id = props.sessionID()
    if (!id) return []
    return props.api.state.session.messages(id).filter((m): m is AssistantMessage => m.role === "assistant")
  })

  const current = createMemo<AssistantMessage | undefined>(() => messages().at(-1))

  // Observed first/last streamed-token wall-clock times for the CURRENT step.
  // (v2 parts carry no per-token timestamps, so we time what we see streaming.)
  const [firstByteAt, setFirstByteAt] = createSignal<number | undefined>(undefined)
  const [lastByteAt, setLastByteAt] = createSignal<number | undefined>(undefined)
  let trackedID: string | undefined
  let seenChars = 0
  let firstSeen = false

  createEffect(() => {
    const m = current()
    const id = m?.id
    const chars = m ? streamedChars(props.api.state.part(m.id)) : 0
    // Reset timing when a new step (assistant message) becomes current.
    if (id !== trackedID) {
      trackedID = id
      seenChars = 0
      firstSeen = false
      setFirstByteAt(undefined)
      setLastByteAt(undefined)
    }
    // Record a timestamp only when new content actually arrives.
    if (chars > seenChars) {
      const now = Date.now()
      if (!firstSeen && chars > 0) {
        firstSeen = true
        setFirstByteAt(now)
      }
      setLastByteAt(now)
      seenChars = chars
    }
  })

  // tokens-per-char learned from the most recent COMPLETED response (real
  // tokens / real chars). Undefined until we have plausible data.
  const calibratedRatio = createMemo<number | undefined>(() => {
    const list = messages()
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (!m.time?.completed) continue
      const tokens = generatedTokens(m)
      if (tokens <= 0) continue
      const chars = streamedChars(props.api.state.part(m.id))
      if (chars <= 0) continue
      const ratio = tokens / chars
      // Guard against tool-heavy steps where output tokens != visible text.
      if (ratio < 0.1 || ratio > 1.5) return undefined
      return ratio
    }
    return undefined
  })

  const tokensPerChar = createMemo<number>(() => {
    if (props.charsPerToken > 0) return 1 / props.charsPerToken // explicit fixed override
    return calibratedRatio() ?? FALLBACK_TOKENS_PER_CHAR
  })

  const stat = createMemo<Stat | undefined>(() => {
    const m = current()
    if (!m) return undefined

    const first = firstByteAt()
    const last = lastByteAt()
    // Active window = first observed token -> last observed token.
    const observedSecs = first !== undefined && last !== undefined ? (last - first) / 1000 : undefined

    // Completed step -> exact tok/s from real token usage.
    const completed = m.time?.completed
    if (completed) {
      const tokens = generatedTokens(m)
      if (tokens <= 0) return undefined
      let secs = observedSecs
      // Fallback when streaming wasn't observed (mounted late / very fast response).
      if (secs === undefined || secs < MIN_WINDOW_SECONDS) {
        const created = m.time?.created
        secs = created ? Math.max((completed - created) / 1000, 0.001) : secs
      }
      if (secs === undefined || secs <= 0) return undefined
      return { kind: "final", tps: tokens / secs, tokens, chars: 0, secs }
    }

    // Streaming -> need an observed window of first..last token.
    if (observedSecs === undefined || observedSecs < MIN_WINDOW_SECONDS) return undefined
    const chars = streamedChars(props.api.state.part(m.id))
    if (chars <= 0) return undefined
    if (!props.liveEstimate) return { kind: "raw", tps: 0, tokens: 0, chars, secs: observedSecs }
    const tokens = chars * tokensPerChar()
    return { kind: "live", tps: tokens / observedSecs, tokens, chars, secs: observedSecs }
  })

  return (
    <Show when={stat()}>
      {(s) => (
        <box
          flexDirection="row"
          flexShrink={0}
          gap={1}
          width={props.compact ? undefined : "100%"}
          paddingLeft={props.compact ? 0 : 2}
          paddingRight={props.compact ? 0 : 2}
        >
          <Show when={props.label}>
            <text fg={theme().textMuted} wrapMode="none">
              {props.label}
            </text>
          </Show>
          <Switch>
            <Match when={s().kind === "raw"}>
              {/* liveEstimate disabled: show progress on the full line; stay quiet inline */}
              <Show when={!props.compact}>
                <text fg={theme().textMuted} wrapMode="none">
                  streaming… · {int(s().chars)} chars · {oneDp(s().secs)}s
                </text>
              </Show>
            </Match>
            <Match when={true}>
              {/* Footer-matched style: value colored, unit muted (like "{ctrl+p} commands") */}
              <text fg={s().kind === "final" ? theme().success : theme().info} wrapMode="none">
                {s().kind === "final" ? "" : "~"}
                {oneDp(s().tps)} <span style={{ fg: theme().textMuted }}>tok/s</span>
              </text>
              <Show when={!props.compact}>
                <text fg={theme().textMuted} wrapMode="none">
                  {s().kind === "final" ? "" : "~"}
                  {int(s().tokens)} tok · {oneDp(s().secs)}s{s().kind === "final" ? "" : " · est"}
                </text>
              </Show>
            </Match>
          </Switch>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const opts = (options ?? {}) as Options
  const slot = opts.slot === "app_bottom" ? "app_bottom" : "session_prompt_right"
  const liveEstimate = opts.liveEstimate !== false
  const charsPerToken = typeof opts.charsPerToken === "number" && opts.charsPerToken > 0 ? opts.charsPerToken : 0
  const label = typeof opts.label === "string" ? opts.label : undefined

  if (slot === "session_prompt_right") {
    api.slots.register({
      order: 100,
      slots: {
        session_prompt_right(_ctx, slotProps) {
          return (
            <Meter
              api={api}
              sessionID={() => slotProps.session_id}
              liveEstimate={liveEstimate}
              charsPerToken={charsPerToken}
              label={label}
              compact
            />
          )
        },
      },
    })
    return
  }

  api.slots.register({
    order: 100,
    slots: {
      app_bottom() {
        const sessionID = () => {
          const route = api.route.current
          return route && route.name === "session" ? (route.params?.sessionID as string | undefined) : undefined
        }
        return (
          <Meter api={api} sessionID={sessionID} liveEstimate={liveEstimate} charsPerToken={charsPerToken} label={label} />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "token-meter",
  tui,
}

export default plugin
