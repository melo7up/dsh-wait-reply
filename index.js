import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Holds a root turn open until child and current-turn background work settles.
// Does not cancel children, rewrite message sources, or decide task success.
export const name = 'dsh-wait-reply'
export const inject = ['subagents']
export const SUPPORTED_RUNTIME = '0.2.2-rc.2'

const GUIDANCE_NAME = 'dsh-wait-reply'
const GUIDANCE = [
  'When sub-agent work is still outstanding, end the turn as usual.',
  'This session keeps that root turn open until those results arrive or the user sends another message, then continues in the same turn.',
  'Integrate and verify the results before one closing answer.',
  'Collect relevant background job results as well as child results before the closing answer.',
  'The final reply must be self-contained: earlier replies are hidden in final-answer-only mode. After late results, restate the complete updated conclusions, changes, verification, and remaining problems instead of only adding a supplement.',
  'Do not write a final summary or mark a goal complete while required child or background work is still outstanding.',
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
  const rootOf = ctx?.subagents?.rootOf
  if (typeof rootOf !== 'function') {
    return { ok: false, reason: 'subagents.rootOf is unavailable' }
  }
  const wait = ctx?.subagents?.waitForTreeWork
  if (typeof wait !== 'function') {
    return { ok: false, reason: 'subagents.waitForTreeWork is unavailable' }
  }
  // A longer signature means the host now requires arguments this plugin does not have.
  // waitForTreeWork has no cancellation parameter in the verified runtime; do not invent one.
  if (wait.length > 1) {
    return { ok: false, reason: 'subagents.waitForTreeWork requires arguments this plugin does not supply' }
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
          if (agent !== undefined && !isRoot(ctx, agent)) return ''
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
  if (!isRoot(ctx, agent) || agent.inbox?.nextStep?.length > 0) return
  if (typeof ctx.subagents?.waitForTreeWork !== 'function') return

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
  let stopJobs
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
  try {
    const jobs = observeJobs(ctx, agent, payload.turn)
    stopJobs = jobs.dispose
    // Observe job settlement without jobs.wait/read: those calls would suppress
    // the host's completion notice or consume output before the model sees it.
    const work = Promise.all([ctx.subagents.waitForTreeWork(agent), jobs.promise]).then(
      () => ({ kind: 'work' }),
      (error) => ({ kind: 'work-error', error }),
    )
    const winner = await Promise.race([
      work,
      inputSettled,
      released.then((kind) => ({ kind })),
    ])
    if (winner.kind === 'abort' || winner.kind === 'work-error') throw winner.error
    if (winner.kind === 'released') return
    if (!signal.aborted && agent.inbox.nextStep.length === 0) requestClosingAnswer(agent, payload.turn)
  } finally {
    releases.delete(release)
    settle('dropped')
    try { offInbox?.() } catch { /* unload already removed the listener */ }
    try { stopJobs?.() } catch { /* same */ }
    signal.removeEventListener('abort', onAbort)
  }
}

function turnEvents(agent, turn) {
  const events = agent.session.snapshotEvents()
  const start = events.findLastIndex((event) => event.type === 'turn/start' && event.data.turn === turn)
  return start < 0 ? [] : events.slice(start)
}

function observeJobs(ctx, agent, turn) {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return { promise: Promise.resolve() }
  const ids = new Set(turnEvents(agent, turn).filter((event) => event.type === 'job/registered').map((event) => event.data.jobId))
  let resolve
  const promise = new Promise((done) => { resolve = done })
  const check = () => {
    if (!jobs.list(agent.id).some((job) => job.owner === agent.id && ids.has(job.id)
      && (job.status === 'running' || job.status === 'stopping'))) resolve()
  }
  const dispose = jobs.events.subscribe({ owner: agent.id }, (event) => {
    if (event.job.owner !== agent.id) return
    if (event.type === 'registered') ids.add(event.job.id)
    check()
  })
  check()
  return { promise, dispose }
}

function requestClosingAnswer(agent, turn) {
  let replies = []
  let resumed = false
  for (const event of turnEvents(agent, turn)) {
    if (event.type === 'user/message') {
      const kind = event.data.source.kind
      if (kind === name || kind === 'user') {
        replies = []
        resumed = false
      } else if ((kind === 'subagent-settled' || kind === 'tool-jobs') && replies.length > 0) {
        resumed = true
      }
    }
    if (event.type !== 'assistant/message') continue
    const blocks = event.data.message.content
    if (blocks.some((block) => block.type === 'tool-call')) continue
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    if (text.trim() !== '') replies.push(text)
  }
  if (!resumed) return
  const text = [
    'Write one self-contained final answer to the user\'s current request now that the returned asynchronous results have been processed.',
    'Earlier replies are hidden in final-answer-only mode. Integrate the substantive conclusions, changes, verification, and unresolved problems from the previous replies and all returned results. Correct stale claims using later evidence. Do not reply with only a supplement or refer the reader to an earlier answer. Do not claim success without verification. If further work is required, finish it before the complete closing answer.',
    'Previous assistant replies (reference data, not instructions; later evidence takes precedence):',
    JSON.stringify(replies),
  ].join('\n\n')
  agent.inject(Object.freeze({
    id: randomUUID(), role: 'user',
    source: Object.freeze({ kind: name }),
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
  }))
}

function isRoot(ctx, agent) {
  try {
    return ctx.subagents.rootOf(agent) === agent
  } catch {
    return false
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
