import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Holds a root turn open until host-managed sub-agent work settles.
// Does not cancel children, rewrite message sources, or decide task success.
export const name = 'dsh-wait-reply'
export const inject = ['agents', 'subagents']
export const SUPPORTED_RUNTIME = '0.2.2-rc.1'

const GUIDANCE_NAME = 'dsh-wait-reply'
const GUIDANCE = [
  'When sub-agent work is still outstanding, end the turn as usual.',
  'This session keeps that root turn open until those results arrive or the user sends another message, then continues in the same turn.',
  'Integrate and verify the results before one closing answer.',
  'Do not write a final summary or mark a goal complete while required child work is still outstanding.',
  'A child finishing, failing, being cancelled, or going idle is not by itself task success.',
  'Do not cancel sub-agents in order to finish the turn.',
].join(' ')

// An arrow function: a `function` declaration is a constructor to Cordis, and
// `new` would discard the cleanup returned here.
export const apply = (ctx) => {
  const assessment = assessHost(ctx)
  if (!assessment.ok) {
    warn(ctx, `dsh-wait-reply stayed inactive: ${assessment.reason}. The session keeps native turn closing.`)
    return
  }

  const releases = new Set()
  registerGuidance(ctx)
  ctx.on('agent/turn-stopping', (payload) => joinRoot(ctx, payload, releases))
  return () => releaseAll(releases)
}

export function assessHost(ctx, version = readHostVersion(ctx)) {
  if (typeof ctx?.agents?.roots !== 'function') {
    return { ok: false, reason: 'agents.roots is unavailable' }
  }
  const wait = ctx?.subagents?.waitForChildren
  if (typeof wait !== 'function') {
    return { ok: false, reason: 'subagents.waitForChildren is unavailable' }
  }
  // A longer signature means the host now requires arguments this plugin does not have.
  // waitForChildren has no cancellation parameter in the verified runtime; do not invent one.
  if (wait.length > 1) {
    return { ok: false, reason: 'subagents.waitForChildren requires arguments this plugin does not supply' }
  }
  if (version !== SUPPORTED_RUNTIME) {
    return { ok: false, reason: `DSH ${version ?? 'unknown'} is outside the verified runtime ${SUPPORTED_RUNTIME}` }
  }
  return { ok: true, version }
}

export function readHostVersion(ctx) {
  const haystack = [new Error().stack ?? '']
  const push = (value) => {
    if (typeof value === 'string' && value !== '') haystack.push(value)
  }
  try { push(ctx?.baseUrl) } catch { /* a tracing proxy can throw on an absent field */ }
  try { push(ctx?.root?.baseUrl) } catch { /* same */ }
  try {
    const loader = ctx?.loader ?? ctx?.get?.('loader')
    for (const entry of loader?.entries?.() ?? []) {
      push(entry?.parent?.tree?.ctx?.baseUrl)
      push(entry?.ctx?.baseUrl)
    }
  } catch { /* loader inspection is only a version hint */ }
  return hostVersionFromText(haystack.join('\n'))
}

export function hostVersionFromText(text) {
  const seen = new Set()
  for (const root of moduleRoots(text)) {
    if (seen.has(root)) continue
    seen.add(root)
    const version = readPackageVersion(join(root, '@deepseek-ai', 'dsh-app-boot', 'package.json'))
    if (version !== undefined) return version
  }
  return undefined
}

function moduleRoots(text) {
  const roots = []
  for (const match of text.matchAll(/node_modules[/\\]@deepseek-ai[/\\]/g)) {
    let start = match.index
    while (start > 0 && !/[\s"'()]/.test(text[start - 1])) start -= 1
    let path = `${text.slice(start, match.index)}node_modules`
    path = path.replace(/^file:\/\//, '')
    if (path.startsWith('///')) path = path.replace(/^\/+/, '/')
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
    try { path = decodeURIComponent(path) } catch { continue }
    roots.push(path)
  }
  return roots
}

function registerGuidance(ctx) {
  ctx.inject(['systemPrompt'], (scope) => {
    const prompt = scope.systemPrompt
    if (typeof prompt?.section !== 'function' || typeof prompt.getSectionOrder !== 'function') {
      warn(ctx, 'dsh-wait-reply could not register session guidance; waiting still applies.')
      return
    }
    try {
      prompt.section({
        name: GUIDANCE_NAME,
        order: prompt.getSectionOrder('TOOL_SUBAGENT') + 1,
        text: (context) => {
          const agent = context?.agent
          if (agent !== undefined && !ctx.agents.roots().includes(agent)) return ''
          return GUIDANCE
        },
      })
    } catch (error) {
      warn(ctx, `dsh-wait-reply could not register session guidance: ${error instanceof Error ? error.message : String(error)}. Waiting still applies.`)
    }
  })
}

async function joinRoot(ctx, payload, releases) {
  const agent = payload?.agent
  const signal = payload?.signal
  if (agent === undefined || signal === undefined || signal.aborted) return
  if (!ctx.agents.roots().includes(agent) || agent.inbox?.nextStep?.length > 0) return
  if (typeof ctx.subagents?.waitForChildren !== 'function') return

  let settle = () => {}
  let offInbox
  try {
    offInbox = ctx.on('agent/inbox/inserted', ({ agent: recipient }) => {
      if (recipient === agent && agent.inbox.nextStep.length > 0) settle('input')
    })
  } catch (error) {
    if (isInactive(error)) return
    throw error
  }

  let onAbort
  let release
  const released = new Promise((resolve) => {
    release = () => resolve('released')
    releases.add(release)
  })
  const input = new Promise((resolve, reject) => {
    settle = (kind) => resolve(kind)
    onAbort = () => reject(signal.reason ?? new Error('Root turn cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else if (agent.inbox.nextStep.length > 0) resolve('input')
  })
  // Convert both racers so a loser cannot surface later as an unhandled rejection.
  // The host wait itself cannot be cancelled; dropping our reference does not cancel children.
  const inputSettled = input.then(
    (kind) => ({ kind }),
    (error) => ({ kind: 'abort', error }),
  )
  const children = ctx.subagents.waitForChildren(agent).then(
    (observed) => ({ kind: 'children', observed }),
    (error) => ({ kind: 'children-error', error }),
  )
  try {
    const winner = await Promise.race([
      children,
      inputSettled,
      released.then((kind) => ({ kind })),
    ])
    if (winner.kind === 'abort' || winner.kind === 'children-error') throw winner.error
  } finally {
    releases.delete(release)
    settle('dropped')
    try { offInbox?.() } catch { /* unload already removed the listener */ }
    signal.removeEventListener('abort', onAbort)
  }
}

function releaseAll(releases) {
  for (const release of releases) release()
  releases.clear()
}

function warn(ctx, message) {
  ctx.logger?.warn?.(message)
}

function isInactive(error) {
  return error?.code === 'INACTIVE_EFFECT' || String(error?.message ?? error).includes('INACTIVE_EFFECT')
}

function readPackageVersion(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed?.name === '@deepseek-ai/dsh-app-boot' && typeof parsed.version === 'string'
      ? parsed.version
      : undefined
  } catch {
    return undefined
  }
}
