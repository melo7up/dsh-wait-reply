import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const pluginDir = fileURLToPath(new URL('..', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/incompatible-bundle/', import.meta.url))
const packages = packagesDir()
const home = await mkdtemp(join(tmpdir(), 'dsh-wait-reply-'))
process.env.DSH_HOME = home
process.env.DSH_TELEMETRY_DISABLED = '1'

const mod = (name) => import(pathToFileURL(join(packages, name, 'lib/index.js')))
const boot = await mod('dsh-app-boot')
const { PROFILE_TEMPLATES } = await mod('dsh-official-bundles')
const { createUserMessage } = await mod('dsh-llm')
const { runProfile } = await import(pathToFileURL(join(packages, 'dsh/lib/profile-boot.js')))

const directory = boot.resolveProfileDir('wait-reply-isolate', home)
boot.initProfile(directory, PROFILE_TEMPLATES.headless.bundles)
await mkdir(join(directory, 'node_modules'), { recursive: true })
await symlink(packages, join(directory, 'node_modules/@deepseek-ai'))
await symlink(pluginDir, join(directory, 'node_modules/dsh-wait-reply'))
await symlink(fixtureDir, join(directory, 'node_modules/dsh-wait-reply-incompatible-fixture'))
const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
manifest.dependencies = {
  'dsh-wait-reply': `file:${pluginDir}`,
  'dsh-wait-reply-incompatible-fixture': `file:${fixtureDir}`,
}
manifest.dsh.profile.bundles.push('dsh-wait-reply', 'dsh-wait-reply-incompatible-fixture')
await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(join(directory, 'cordis.patch.yml'), `${JSON.stringify([
  { id: 'headless-startup', disabled: true },
  { id: 'headless-runner', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'credentials', config: { watch: false } },
  { id: 'sandbox-policy', inject: [], config: { mode: 'workspace-write', workspaceRoot: home, additionalWritableRoots: [] } },
  { id: 'hmr', disabled: false },
])}\n`)

const resolvedProfile = boot.loadProfile('dsh', 'wait-reply-isolate', join(directory, 'package.json'), home)
const skipped = resolvedProfile.skippedBundles.find((item) => item.packageName === 'dsh-wait-reply-incompatible-fixture')
assert.ok(skipped, 'incompatible fixture must be skipped instead of blocking startup')
assert.match(skipped.reason, /9\.9\.9/)
assert.equal(globalThis.__DSH_WAIT_REPLY_INCOMPATIBLE_IMPORTED__, undefined)
const booted = await runProfile({
  profile: 'wait-reply-isolate',
  resolvedProfile,
  patchFiles: [],
  args: [],
  environment: boot.loadLayeredEnv('dsh'),
})
const ctx = booted.ctx
const agentErrors = []
ctx.on('agent/error', (payload) => agentErrors.push(payload.error))
const deadline = setTimeout(() => {
  console.error('ISOLATE_TIMEOUT')
  process.exit(2)
}, 120000)
let current
const owners = new Map()
const checks = []

function packagesDir() {
  const flag = process.argv.indexOf('--packages')
  const explicit = flag >= 0 ? process.argv[flag + 1] : process.env.DSH_PACKAGES
  const candidates = [
    explicit,
    '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai',
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'dsh-app-boot', 'package.json'))) return dir
  }
  throw new Error('Pass --packages <path-to-@deepseek-ai> or set DSH_PACKAGES')
}

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
async function until(predicate, label, timeoutMs = 8000) {
  const start = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - start < timeoutMs, `Timed out: ${label}`)
    await new Promise((done) => setTimeout(done, 5))
  }
}
function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
function toolChunks(calls) {
  return calls.flatMap(([toolName, args], index) => {
    const id = randomUUID()
    const argumentsText = JSON.stringify(args)
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: toolName, argumentsDelta: argumentsText },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: toolName, arguments: argumentsText } },
    ]
  }).concat([{ type: 'finish', reason: { kind: 'tool-calls' } }])
}
function waitingText(agent) {
  return agent.session.snapshotEvents().some((event) => event.type === 'assistant/message'
    && event.data.message.content.some((block) => block.type === 'text' && String(block.text).startsWith('WAITING_FOR_REVIEW')))
}
function hasTurnEnd(agent) {
  return agent.session.snapshotEvents().some((event) => event.type === 'turn/end')
}
async function untilHeld(state) {
  const start = Date.now()
  while (Date.now() - start < 8000) {
    if (waitingText(state.agent) && state.agent.status === 'running' && !hasTurnEnd(state.agent)) {
      await new Promise((done) => setTimeout(done, 40))
      if (state.agent.status === 'running' && !hasTurnEnd(state.agent)) return
    }
    await new Promise((done) => setTimeout(done, 5))
  }
  assert.fail('plugin did not hold the root turn')
}
function renderedPrompt(agent) {
  return ctx.systemPrompt.assemble(agent === undefined ? {} : { agent }).then((assembly) => assembly.sections.map((section) => section.text).join('\n'))
}

const adapter = {
  providerInfo: (id) => ({ id, name: 'Offline scripted probe' }),
  providerRetryPolicy: () => undefined,
  imageRequestPricing: () => undefined,
  listModels: async () => [{ provider: 'reply-probe', id: 'scripted', name: 'Scripted', inputModalities: ['text'] }],
  resolveModel: async (provider, id) => ({ provider, id, name: id, inputModalities: ['text'] }),
  async prepareCall(provider, model) {
    return { model: await adapter.resolveModel(provider, model), stream: (options) => adapter.stream(options) }
  },
  async *stream(options) {
    const state = owners.get(options.sessionId) ?? current
    if (!owners.has(options.sessionId)) owners.set(options.sessionId, state)
    if (options.sessionId !== state.agent.id) {
      const text = JSON.stringify(options.messages)
      const key = text.includes('CHILD_A') ? 'A' : 'B'
      state.started.add(key)
      state.childIds.add(options.sessionId)
      let onAbort
      try {
        await Promise.race([state.gates[key].promise, new Promise((_, reject) => {
          onAbort = () => reject(options.signal.reason ?? new Error('Child cancelled'))
          options.signal?.addEventListener('abort', onAbort, { once: true })
          if (options.signal?.aborted) onAbort()
        })])
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.throwIfAborted()
      if (state.failChild && key === 'B') throw new Error('Expected offline fixture child failure')
      yield* textChunks(`RESULT_${key}`)
      return
    }
    const agent = state.agent
    if (state.goal && !state.createdGoal) {
      state.createdGoal = true
      yield* toolChunks([['create_goal', { objective: 'Collect both child results and provide one closing answer.', max_goal_rounds: 5 }]])
      return
    }
    if (!state.spawned && !state.noChildren) {
      state.spawned = true
      yield* toolChunks(['A', 'B'].map((key) => ['subagent', { description: `Child ${key}`, prompt: `CHILD_${key}: return your result.` }]))
      return
    }
    const settled = agent.session.snapshotEvents().filter((event) => event.type === 'user/message' && event.data.source?.kind === 'subagent-settled')
    state.seenNotices = settled.length
    if (settled.length < (state.noChildren ? 0 : 2)) {
      yield* textChunks(`WAITING_FOR_REVIEW_${settled.length}`)
      return
    }
    const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn
    if (state.goal && !state.completeAttempts.has(turn)) {
      state.completeAttempts.add(turn)
      const goal = ctx.goals.get(agent)
      if (goal?.phase === 'active') {
        yield* toolChunks([['update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }]])
        return
      }
    }
    yield* textChunks('FINAL_ALL_RESULTS')
  },
}
ctx.llm.registerAdapter(['reply-probe'], adapter)

async function pluginRow() {
  const rows = await ctx.pluginManager.listPlugins()
  const row = rows.find((item) => item.moduleName === 'dsh-wait-reply')
  assert.ok(row, 'loader did not publish the plugin row')
  return row
}
async function setEnabled(enabled) {
  const row = await pluginRow()
  assert.equal(row.readOnlyReason, undefined, JSON.stringify(row))
  const result = await ctx.pluginManager.setPluginEnabled(row.entryId, enabled)
  assert.equal(result.application, 'applied', JSON.stringify(result))
  const after = await pluginRow()
  assert.equal(after.enabled, enabled)
  assert.equal(after.fiberPhase, enabled ? 'active' : null)
  return after
}

async function startCase(extra = {}) {
  const state = {
    ...extra,
    gates: { A: deferred(), B: deferred() },
    started: new Set(),
    childIds: new Set(),
    completeAttempts: new Set(),
    seenNotices: 0,
  }
  const created = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: home },
    agentOptions: { provider: 'reply-probe', model: 'scripted' },
    setup: async () => {},
  })
  state.agent = created.agent
  current = state
  state.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Start one task and collect both children.' }],
    source: { kind: 'user' },
  }))
  return state
}

function childrenOf(state) {
  return [...state.childIds].map((id) => ctx.agents.get(id)).filter(Boolean)
}

function summarize(state, extra = {}) {
  const events = state.agent.session.snapshotEvents()
  const userSources = events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'user')
  const settled = events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'subagent-settled')
  return {
    completedTurns: events.filter((event) => event.type === 'turn/end' && event.data.reason?.kind === 'completed').length,
    authorityErrors: events.filter((event) => event.type === 'tool/result' && event.data.error?.code === 'GOAL_TOOL_AUTHORITY_REQUIRED').length,
    finalSummaries: events.filter((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'text' && block.text === 'FINAL_ALL_RESULTS')).length,
    userSources: userSources.length,
    settledSources: settled.length,
    ...extra,
  }
}

async function runCase(hold, goal, extra = {}) {
  const state = await startCase({ goal, ...extra })
  if (!state.noChildren) {
    await until(() => state.started.size === 2, 'two real children started')
    if (hold) {
      await untilHeld(state)
      const child = childrenOf(state).find((agent) => !ctx.agents.roots().includes(agent))
      assert.ok(child, 'expected a non-root child agent')
      assert.doesNotMatch(await renderedPrompt(child), /keeps that root turn open/)
    } else {
      await state.agent.whenIdle()
    }
    if (state.cancel) {
      state.agent.cancel({ kind: 'user' })
      await state.agent.whenIdle()
      const ends = state.agent.session.snapshotEvents().filter((event) => event.type === 'turn/end')
      assert.equal(ends.at(-1)?.data.reason.kind, 'aborted')
      state.gates.A.resolve()
      state.gates.B.resolve()
      await Promise.all(childrenOf(state).map((child) => child.whenIdle()))
      const result = summarize(state, { cancellation: 'responsive', completedTurns: ends.filter((event) => event.data.reason.kind === 'completed').length })
      checks.push({ case: extra.label, ...result })
      return result
    }
    if (state.userSteer) {
      const previous = state.agent.session.snapshotEvents().filter((event) => event.type === 'assistant/message').length
      state.agent.steer(createUserMessage({
        content: [{ type: 'text', text: 'USER_STEER: keep waiting and include both results.' }],
        source: { kind: 'user' },
      }))
      await until(() => state.agent.session.snapshotEvents().filter((event) => event.type === 'assistant/message').length > previous, 'user steering processed before either child finishes')
      assert.equal(state.agent.status, 'running')
    }
    state.gates.A.resolve()
    await until(() => state.seenNotices >= 1, 'parent processed first result')
    if (!hold) await state.agent.whenIdle()
    state.gates.B.resolve()
    await until(() => state.seenNotices >= 2, 'parent processed second result')
  }
  await state.agent.whenIdle()
  if (goal) {
    await until(() => ctx.goals.get(state.agent)?.phase === 'complete', 'goal eventually completed')
    await state.agent.whenIdle()
  }
  await new Promise((done) => setTimeout(done, 25))
  const result = summarize(state)
  if (!state.noChildren) assert.equal(result.settledSources, 2)
  assert.equal(result.userSources, state.userSteer ? 2 : 1)
  checks.push({ case: extra.label, ...result })
  return result
}

try {
  assert.equal(globalThis.__DSH_WAIT_REPLY_INCOMPATIBLE_IMPORTED__, undefined)
  const loaded = await pluginRow()
  assert.equal(loaded.enabled, true)
  assert.equal(loaded.fiberPhase, 'active')
  assert.equal(loaded.patchId, 'dsh-wait-reply')
  assert.match(await renderedPrompt(), /keeps that root turn open/)
  checks.push({ case: 'loader assembly', fiberPhase: loaded.fiberPhase, incompatibleSkipped: true })

  await setEnabled(false)
  assert.doesNotMatch(await renderedPrompt(), /keeps that root turn open/)
  const baseline = await runCase(false, true, { label: 'native after disable' })
  assert.ok(baseline.completedTurns > 1, 'disabled plugin must restore multiple native closings')
  assert.equal(baseline.authorityErrors, 1, 'native baseline must still lose completion authority')

  await setEnabled(true)
  assert.match(await renderedPrompt(), /keeps that root turn open/)
  const joined = await runCase(true, true, { label: 'plugin with goal and two children' })
  assert.equal(joined.completedTurns, 1)
  assert.equal(joined.authorityErrors, 0)
  assert.equal(joined.finalSummaries, 1)
  const noGoal = await runCase(true, false, { label: 'plugin without goal' })
  assert.equal(noGoal.completedTurns, 1)
  assert.equal(noGoal.finalSummaries, 1)
  const noChildren = await runCase(true, false, { noChildren: true, label: 'plugin with no children' })
  assert.equal(noChildren.completedTurns, 1)
  const steering = await runCase(true, true, { userSteer: true, label: 'plugin with user steering' })
  assert.equal(steering.completedTurns, 1)
  assert.equal(steering.authorityErrors, 0)
  const beforeFailure = agentErrors.length
  const childFailure = await runCase(true, true, { failChild: true, label: 'plugin with child failure' })
  assert.equal(childFailure.completedTurns, 1)
  assert.equal(childFailure.authorityErrors, 0)
  assert.ok(agentErrors.slice(beforeFailure).some((error) => String(error).includes('Expected offline fixture child failure')))
  await runCase(true, false, { cancel: true, label: 'plugin with user cancellation' })

  const held = await startCase({ label: 'disable while waiting' })
  await until(() => held.started.size === 2, 'children started before disable')
  await untilHeld(held)
  const children = childrenOf(held)
  assert.ok(children.length >= 2)
  for (const child of children) assert.equal(child.status, 'running')
  await setEnabled(false)
  await until(() => held.agent.status === 'idle', 'parent idle after disable', 15000)
  for (const child of children) {
    assert.equal(child.status, 'running', 'disabling the plugin must not cancel children')
    assert.equal(child.session.snapshotEvents().some((event) => event.type === 'turn/end' && event.data.reason?.kind === 'aborted'), false)
  }
  const released = summarize(held)
  assert.ok(released.completedTurns >= 1)
  assert.ok(released.settledSources < 2)
  assert.doesNotMatch(await renderedPrompt(), /keeps that root turn open/)
  held.gates.A.resolve()
  held.gates.B.resolve()
  await Promise.all(children.map((child) => child.whenIdle()))
  checks.push({ case: 'disable while waiting', ...released, childrenCancelled: false })

  await setEnabled(true)
  const rejoined = await runCase(true, true, { label: 'plugin after re-enable' })
  assert.equal(rejoined.completedTurns, 1)
  assert.equal(rejoined.authorityErrors, 0)

  const bundleOff = await ctx.pluginManager.setBundleEnabled('dsh-wait-reply', false)
  assert.equal(bundleOff.application, 'applied', JSON.stringify(bundleOff))
  const gone = await ctx.pluginManager.listPlugins()
  assert.equal(gone.some((item) => item.moduleName === 'dsh-wait-reply'), false)
  assert.doesNotMatch(await renderedPrompt(), /keeps that root turn open/)
  const afterBundleOff = await runCase(false, true, { label: 'native after bundle disable' })
  assert.ok(afterBundleOff.completedTurns > 1)

  const removed = await ctx.pluginManager.removeBundle('dsh-wait-reply')
  assert.notEqual(removed.application, 'failed', JSON.stringify(removed))
  const afterRemove = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(afterRemove.dependencies ?? {}, 'dsh-wait-reply'), false)
  assert.equal((afterRemove.dsh?.profile?.bundles ?? []).includes('dsh-wait-reply'), false)
  checks.push({ case: 'uninstall', application: removed.application, dependencyRemoved: true })

  console.log(JSON.stringify({ result: 'ISOLATION_PROOF_PASSED', realModelRequests: 0, checks }, null, 2))
} catch (error) {
  console.error('ISOLATE_FAILURE', error)
  console.error(JSON.stringify(checks, null, 2))
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await ctx.fiber.dispose()
}
