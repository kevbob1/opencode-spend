/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { createSignal, createMemo, type Accessor, type Setter } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// User config at ~/.config/opencode/spend.json. Currently controls where the
// total spend is displayed: the sidebar section, the prompt footer (right), or
// both. Falls back to defaults if the file is missing or malformed.
const CONFIG_PATH = join(homedir(), ".config", "opencode", "spend.json")

type SpendLocation = "both" | "sidebar" | "prompt"

type SpendConfig = {
  location: SpendLocation
}

const DEFAULT_CONFIG: SpendConfig = {
  location: "both",
}

function loadConfig(): SpendConfig {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    const location = raw?.location
    if (location === "both" || location === "sidebar" || location === "prompt") {
      return { location }
    }
  } catch {
    // fall back to defaults
  }
  return { ...DEFAULT_CONFIG }
}

async function sumDescendants(
  client: OpencodeClient,
  sessionID: string,
  visited: Set<string>,
  depth: number,
): Promise<number> {
  if (depth > 10) return 0
  if (visited.has(sessionID)) return 0
  visited.add(sessionID)
  try {
    const result = await client.session.children({ sessionID })
    const children = (result.data ?? []).filter((s) => !visited.has(s.id))
    const ownCost = children.reduce((sum, s) => sum + (s.cost ?? 0), 0)
    let nested = 0
    for (const child of children) {
      nested += await sumDescendants(client, child.id, visited, depth + 1)
    }
    return ownCost + nested
  } catch {
    return 0
  }
}

// One tracker per orchestrator session, created exactly ONCE and stored at
// module scope. The slot renderer can be invoked many times, so all stateful
// setup (event subscription, polling) lives here behind a strict guard. The
// previous version created this inside the render body, which re-ran on every
// reactive update and produced an infinite refresh loop plus a listener leak.
type Tracker = {
  cost: Accessor<number>
  setCost: Setter<number>
  started: boolean
  dispose: () => void
}

const trackers = new Map<string, Tracker>()

function getTracker(sessionID: string): Tracker {
  let tracker = trackers.get(sessionID)
  if (tracker) return tracker
  const [cost, setCost] = createSignal(0)
  tracker = { cost, setCost, started: false, dispose: () => {} }
  trackers.set(sessionID, tracker)
  return tracker
}

// Begin watching a session's subagent spend. Guarded by `started` so it only
// ever runs once per tracker no matter how often the view mounts.
function startTracker(api: TuiPluginApi, sessionID: string) {
  const tracker = getTracker(sessionID)
  if (tracker.started) return
  tracker.started = true

  let inFlight = false
  let dirty = false
  let disposed = false

  async function refresh() {
    if (disposed) return
    if (inFlight) {
      dirty = true
      return
    }
    inFlight = true
    dirty = false
    try {
      const total = await sumDescendants(api.client, sessionID, new Set(), 0)
      if (!disposed) tracker.setCost(total)
    } finally {
      inFlight = false
      if (dirty && !disposed) void refresh()
    }
  }

  // Subagent message.updated events DO reach api.event.on (verified), carrying
  // the subagent's own sessionID. Any such event means a descendant's spend may
  // have changed, so recompute the tree (coalesced to avoid pile-up).
  const handler = () => {
    if (disposed) return
    void refresh()
  }
  const offMessage = api.event.on("message.updated", handler as never)
  const offIdle = api.event.on("session.idle", handler as never)

  tracker.dispose = () => {
    disposed = true
    offMessage()
    offIdle()
    trackers.delete(sessionID)
  }

  void refresh()
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function sessionCost(api: TuiPluginApi, sessionID: string) {
  return api.state.session.messages(sessionID).reduce(
    (total, message) => total + (message.role === "assistant" ? message.cost : 0),
    0,
  )
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  startTracker(props.api, props.session_id)
  const tracker = getTracker(props.session_id)

  const total = createMemo(() => sessionCost(props.api, props.session_id) + tracker.cost())

  return (
    <box>
      <text fg={theme().text}>
        <b>Total Spend</b>
      </text>
      <text fg={theme().textMuted}>
        {money.format(total())} ({money.format(tracker.cost())})
      </text>
    </box>
  )
}

function PromptRight(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current

  startTracker(props.api, props.session_id)
  const tracker = getTracker(props.session_id)

  const total = createMemo(() => sessionCost(props.api, props.session_id) + tracker.cost())

  return (
    <text fg={theme().textMuted}>
      {money.format(total())} ({money.format(tracker.cost())})
    </text>
  )
}

const tui: TuiPlugin = async (api) => {
  const config = loadConfig()
  const showSidebar = config.location === "both" || config.location === "sidebar"
  const showPrompt = config.location === "both" || config.location === "prompt"

  const slots: Parameters<typeof api.slots.register>[0]["slots"] = {}
  if (showSidebar) {
    slots.sidebar_content = (_ctx, props) => <View api={api} session_id={props.session_id} />
  }
  if (showPrompt) {
    slots.session_prompt_right = (_ctx, props) => (
      <PromptRight api={api} session_id={props.session_id} />
    )
  }

  api.slots.register({ id: "spend", order: 150, slots } as unknown as Parameters<typeof api.slots.register>[0])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "spend",
  tui,
}

export default plugin
