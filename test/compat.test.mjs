import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, assessHost, hostVersionFromText, SUPPORTED_RUNTIME } from '../index.js'

function host(waitLength = 1) {
  function rootOf(agent) { return agent }
  function waitForTreeWork(root) {}
  if (waitLength > 1) {
    return {
      subagents: { rootOf, waitForTreeWork(root, signal) {} },
    }
  }
  return {
    subagents: { rootOf, waitForTreeWork },
  }
}

test('a matching runtime with the verified methods is accepted', () => {
  assert.deepEqual(assessHost(host(), SUPPORTED_RUNTIME), { ok: true, version: SUPPORTED_RUNTIME })
})

test('a different or unknown runtime stays inactive', () => {
  assert.equal(assessHost(host(), '0.2.3').ok, false)
  assert.match(assessHost(host(), undefined).reason, /unknown/)
})

test('a missing or longer child-wait method stays inactive', () => {
  assert.match(assessHost({ subagents: { rootOf() {} } }, SUPPORTED_RUNTIME).reason, /waitForTreeWork/)
  assert.match(assessHost(host(2), SUPPORTED_RUNTIME).reason, /arguments/)
  assert.match(assessHost({ subagents: { waitForTreeWork() {} } }, SUPPORTED_RUNTIME).reason, /rootOf/)
})

test('an encoded file URL in a stack still resolves the host package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wait-reply-version-'))
  const spaced = join(root, 'DeepSeek Harness')
  const pkgDir = join(spaced, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: SUPPORTED_RUNTIME }))
  const stack = `at Fiber.execute (file://${spaced.replaceAll(' ', '%20')}/node_modules/@deepseek-ai/cordis/lib/index.js:362:24)`
  assert.equal(hostVersionFromText(stack), SUPPORTED_RUNTIME)
  assert.equal(hostVersionFromText('no host here'), undefined)
})

test('apply does not register a listener when the host cannot be verified', () => {
  let registered = false
  const warnings = []
  apply({
    subagents: { rootOf(agent) { return agent }, waitForTreeWork() {} },
    logger: { warn: (message) => warnings.push(message) },
    on() { registered = true },
  })
  assert.equal(registered, false)
  assert.match(warnings.join('\n'), /stayed inactive/)
  assert.match(warnings.join('\n'), /native turn closing/)
})
