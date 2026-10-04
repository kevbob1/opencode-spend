import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { jsx, jsxs } from "@opentui/solid/jsx-runtime"
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyData = any

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

// `context.data.session.cost(rootID)` already returns the family total (root
// + all descendants) and is updated live by the host on every
// `session.usage.updated` event. But child sessions only land in the store
// once the host has synced them, so on mount we walk the tree via the
// supported API (`client.session.list({ parentID })` — there is no
// `client.session.children`) and sync each child into the store. New
// subagents created afterwards are auto-synced by the host's
// `session.created` handler, which also registers them with the family.
async function seedFamily(client: AnyClient, data: AnyData, rootID: string): Promise<void> {
  try {
    await data.session.sync(rootID)
  } catch {
    // best effort; the reactive reads below still work
  }
  const seen = new Set<string>([rootID])
  const queue: string[] = [rootID]
  while (queue.length > 0) {
    if (seen.size > 500) return
    const parentID = queue.pop()!
    let children: Array<{ id: string }> = []
    try {
      const response = await client.session.list({ parentID })
      children = response.data ?? []
    } catch {
      continue
    }
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      queue.push(child.id)
      try {
        await data.session.sync(child.id)
      } catch {
        // ignore one bad child
      }
    }
  }
}

// Reactive spend for one root session. Reads only go through the host data
// store inside memos, so updates (usage deltas, new children) re-render
// without any manual polling or event bookkeeping.
function useSpend(sessionID: () => string | undefined) {
  const context = usePlugin()

  createEffect(() => {
    const id = sessionID()
    if (!id) return
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    void seedFamily(context.client, context.data, id).catch(() => {})
    // Belt-and-braces for late-joining subagents: adopt any created session
    // whose parent chain reaches our root. (The host auto-syncs created
    // sessions too; this just covers sessions the host hasn't registered.)
    const off = context.data.on("session.created", (event) => {
      if (cancelled) return
      const created = event.data as { sessionID: string; parentID?: string }
      if (!created?.sessionID) return
      let current = created.parentID
      let depth = 0
      while (current && depth < 10) {
        if (current === id) {
          void context.data.session.sync(created.sessionID).catch(() => {})
          return
        }
        current = context.data.session.get(current)?.parentID
        depth += 1
      }
    })
    onCleanup(off)
  })

  const total = createMemo(() => {
    const id = sessionID()
    if (!id) return 0
    return context.data.session.cost(id)
  })
  const own = createMemo(() => {
    const id = sessionID()
    if (!id) return 0
    return context.data.session.get(id)?.cost ?? 0
  })
  const subagents = createMemo(() => Math.max(0, total() - own()))

  return { total, subagents }
}

function View(props: { input: { sessionID: string } }) {
  const context = usePlugin()
  const theme = context.theme
  const sessionID = createMemo(() => props.input.sessionID)
  const { total, subagents } = useSpend(sessionID)

  return jsxs("box", {
    children: [
      jsx("text", {
        get fg() {
          return theme.text
        },
        get children() {
          return jsx("b", { children: "Total Spend" })
        },
      }),
      jsx("text", {
        get fg() {
          return theme.textMuted
        },
        get children() {
          return `${money.format(total())} (${money.format(subagents())})`
        },
      }),
    ],
  })
}

function PromptFooter(props: { input: { sessionID?: string } }) {
  const context = usePlugin()
  const theme = context.theme
  const sessionID = createMemo(() => props.input.sessionID)
  const { total, subagents } = useSpend(sessionID)

  return jsx("text", {
    get fg() {
      return theme.textMuted
    },
    get children() {
      return `${money.format(total())} (${money.format(subagents())})`
    },
  })
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        render: (input) => (jsx as any)(View, { input }),
      })
    }

    if (showPrompt) {
      // Use prompt.footer.status for the prompt footer right area
      context.ui.slot({
        append: "prompt.footer.status",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        render: (input) => (jsx as any)(PromptFooter, { input }),
      })
    }
  },
})
