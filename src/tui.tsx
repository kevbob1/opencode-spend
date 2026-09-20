/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any

async function sumDescendants(
  client: AnyClient,
  sessionID: string,
  visited: Set<string>,
  depth: number,
): Promise<number> {
  if (depth > 10) return 0
  if (visited.has(sessionID)) return 0
  visited.add(sessionID)
  try {
    const result = await client.session.children({ sessionID })
    const children = (result.data ?? []).filter((s: { id: string }) => !visited.has(s.id))
    const ownCost = children.reduce((sum: number, s: { cost?: number }) => sum + (s.cost ?? 0), 0)
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

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function getSessionID(context: ReturnType<typeof usePlugin>): string | undefined {
  const route = context.ui.router.current()
  if (route.type === "session") {
    return route.sessionID
  }
  return undefined
}

function View() {
  const context = usePlugin()
  const theme = context.theme

  const sessionID = createMemo(() => getSessionID(context))

  const tracker = createMemo(() => {
    const id = sessionID()
    if (!id) return getTracker("")
    return getTracker(id)
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextClient: AnyClient = context.client

  // Begin watching a session's subagent spend. Guarded by `started` so it only
  // ever runs once per tracker no matter how often the view mounts.
  createMemo(() => {
    const id = sessionID()
    if (!id) return
    const trackerInstance = getTracker(id)
    if (trackerInstance.started) return
    trackerInstance.started = true

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
        const total = await sumDescendants(contextClient, id!, new Set(), 0)
        if (!disposed) trackerInstance.setCost(total)
      } finally {
        inFlight = false
        if (dirty && !disposed) void refresh()
      }
    }

    // Subagent events may indicate a descendant's spend changed, so recompute the tree
    // (coalesced to avoid pile-up).
    const handler = () => {
      if (disposed) return
      void refresh()
    }
    // Use session idle event as a proxy for when subagent costs are finalized
    const offIdle = context.data.on("session.idle" as any, handler)

    trackerInstance.dispose = () => {
      disposed = true
      offIdle()
      trackers.delete(id!)
    }

    void refresh()
  })

  const total = createMemo(() => {
    const id = sessionID()
    if (!id) return 0
    const messages = context.data.session.message.list(id) ?? []
    const sessionCost = messages.reduce(
      (total: number, message: any) => total + (message.role === "assistant" ? message.cost ?? 0 : 0),
      0,
    )
    return sessionCost + tracker().cost()
  })

  return (
    <box>
      <text fg={theme.text}>
        <b>Total Spend</b>
      </text>
      <text fg={theme.textMuted}>
        {money.format(total())} ({money.format(tracker().cost())})
      </text>
    </box>
  )
}

function PromptFooter() {
  const context = usePlugin()
  const theme = context.theme

  const sessionID = createMemo(() => getSessionID(context))

  const tracker = createMemo(() => {
    const id = sessionID()
    if (!id) return getTracker("")
    return getTracker(id)
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextClient: AnyClient = context.client

  // Begin watching a session's subagent spend. Guarded by `started` so it only
  // ever runs once per tracker no matter how often the view mounts.
  createMemo(() => {
    const id = sessionID()
    if (!id) return
    const trackerInstance = getTracker(id)
    if (trackerInstance.started) return
    trackerInstance.started = true

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
        const total = await sumDescendants(contextClient, id!, new Set(), 0)
        if (!disposed) trackerInstance.setCost(total)
      } finally {
        inFlight = false
        if (dirty && !disposed) void refresh()
      }
    }

    const handler = () => {
      if (disposed) return
      void refresh()
    }
    const offIdle = context.data.on("session.idle" as any, handler)

    trackerInstance.dispose = () => {
      disposed = true
      offIdle()
      trackers.delete(id!)
    }

    void refresh()
  })

  const total = createMemo(() => {
    const id = sessionID()
    if (!id) return 0
    const messages = context.data.session.message.list(id) ?? []
    const sessionCost = messages.reduce(
      (total: number, message: any) => total + (message.role === "assistant" ? message.cost ?? 0 : 0),
      0,
    )
    return sessionCost + tracker().cost()
  })

  return (
    <text fg={theme.textMuted}>
      {money.format(total())} ({money.format(tracker().cost())})
    </text>
  )
}

export default Plugin.define({
  id: "spend",
  setup(context) {
    const config = loadConfig()
    const showSidebar = config.location === "both" || config.location === "sidebar"
    const showPrompt = config.location === "both" || config.location === "prompt"

    if (showSidebar) {
      context.ui.slot({
        append: "sidebar.content",
        render: () => <View />,
      })
    }

    if (showPrompt) {
      // Use prompt.footer.status for the prompt footer right area
      context.ui.slot({
        append: "prompt.footer.status",
        render: () => <PromptFooter />,
      })
    }
  },
})
