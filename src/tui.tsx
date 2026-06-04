/** @jsxImportSource @opentui/solid */
/**
 * opencode-token-meter (TUI plugin)
 * -------------------------------------------------------------------------
 * Renders a tokens/second readout natively in the TUI, inline in the prompt's
 * status/meta row — the same status cluster as the model name and the
 * context% / "ctrl+p commands" hints (the `session_prompt_right` slot).
 *
 * How the rate is measured — ACTIVE generation time only:
 *   The plugin watches the stream and accumulates elapsed time *only* between
 *   consecutive tokens that arrive close together (within `gapMs`). Any longer
 *   gap is treated as idle and is NOT counted, so the rate excludes:
 *     - time-to-first-token (nothing is counted before the first token),
 *     - command/tool execution (no tokens stream while a tool runs), and
 *     - time spent waiting on the user (permissions, prompts), and
 *     - the trailing finalization after the last token.
 *   Because idle gaps aren't counted, the displayed value stays frozen while a
 *   command/tool is running instead of drifting down.
 *
 *   (opencode's v2 message model attaches no per-token timestamps, so timing is
 *   based on when the plugin observes content arrive.)
 *
 *   Tokens:
 *     - On completion  -> EXACT count from real provider usage (output + reasoning).
 *     - While streaming -> estimated from streamed chars, calibrated from the
 *       last completed response's real tokens/char (never a fixed 4; 4 is only
 *       the cold-start fallback). Set liveEstimate=false to skip the estimate.
 *
 * Registered via `.opencode/tui.json`. Options:
 *   slot          "session_prompt_right" (default, inline in prompt footer) | "app_bottom" (own line below prompt)
 *   liveEstimate  boolean, show estimated tok/s while streaming (default true)
 *   charsPerToken number, force a fixed estimate divisor; 0 = auto-calibrate (default 0)
 *   gapMs         number, max ms between tokens still counted as active (default 1000)
 *   label         string, optional prefix shown before the readout
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, Match, Show, Switch } from "solid-js"

type Options = {
  slot?: "app_bottom" | "session_prompt_right"
  liveEstimate?: boolean
  charsPerToken?: number
  gapMs?: number
  label?: string
}

// kind: "final" = exact real tokens; "live" = calibrated estimate; "raw" = no estimate, progress only
type Stat = { kind: "final" | "live" | "raw"; tps: number; tokens: number; chars: number; secs: number }

const FALLBACK_TOKENS_PER_CHAR = 1 / 4 // cold-start only, before any real usage is known
const MIN_WINDOW_SECONDS = 0.25 // ignore windows too short to yield a meaningful rate
const DEFAULT_GAP_MS = 1000 // gaps longer than this (tool/command/idle) are not counted

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
  gapMs: number
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

  // Accumulated ACTIVE generation time (ms) for the current response: the sum of
  // intervals between consecutive tokens that arrived within `gapMs`. Larger gaps
  // (a command/tool running, or waiting on the user) are skipped, so this clock
  // pauses whenever the model isn't actively streaming.
  const [activeMs, setActiveMs] = createSignal(0)
  let trackedID: string | undefined
  let seenChars = 0
  let lastSeenAt: number | undefined
  let activeAcc = 0

  createEffect(() => {
    const m = current()
    const id = m?.id
    const chars = m ? streamedChars(props.api.state.part(m.id)) : 0
    // Reset when a new response (assistant message) becomes current.
    if (id !== trackedID) {
      trackedID = id
      seenChars = 0
      lastSeenAt = undefined
      activeAcc = 0
      setActiveMs(0)
    }
    // New content arrived: add the interval since the previous token, but only
    // if it's short enough to be "still streaming" (otherwise it was idle/tool).
    if (chars > seenChars) {
      const now = Date.now()
      if (lastSeenAt !== undefined) {
        const delta = now - lastSeenAt
        if (delta > 0 && delta <= props.gapMs) activeAcc += delta
      }
      lastSeenAt = now
      seenChars = chars
      setActiveMs(activeAcc)
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

    const active = activeMs() / 1000 // active generation seconds (idle/tool gaps excluded)

    // Completed -> exact tok/s from real token usage over the active window.
    const completed = m.time?.completed
    if (completed) {
      const tokens = generatedTokens(m)
      if (tokens <= 0) return undefined
      let secs = active
      // Fallback when streaming wasn't observed (mounted late / very fast response).
      if (secs < MIN_WINDOW_SECONDS) {
        const created = m.time?.created
        secs = created ? Math.max((completed - created) / 1000, 0.001) : secs
      }
      if (secs < MIN_WINDOW_SECONDS) return undefined
      return { kind: "final", tps: tokens / secs, tokens, chars: 0, secs }
    }

    // Streaming -> need enough active time for a meaningful rate.
    if (active < MIN_WINDOW_SECONDS) return undefined
    const chars = streamedChars(props.api.state.part(m.id))
    if (chars <= 0) return undefined
    if (!props.liveEstimate) return { kind: "raw", tps: 0, tokens: 0, chars, secs: active }
    const tokens = chars * tokensPerChar()
    return { kind: "live", tps: tokens / active, tokens, chars, secs: active }
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
  const gapMs = typeof opts.gapMs === "number" && opts.gapMs > 0 ? opts.gapMs : DEFAULT_GAP_MS
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
              gapMs={gapMs}
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
          <Meter
            api={api}
            sessionID={sessionID}
            liveEstimate={liveEstimate}
            charsPerToken={charsPerToken}
            gapMs={gapMs}
            label={label}
          />
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
