import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, assessHost, hostVersionFromText, runtimeSupported } from '../index.js'

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

test('a 0.2 runtime with the verified methods is accepted', () => {
  for (const version of ['0.2.2-rc.2', '0.2.2-rc.5', '0.2.2-rc.10', '0.2.2', '0.2.3', '0.2.3-rc.1']) {
    assert.equal(runtimeSupported(version), true, version)
    assert.deepEqual(assessHost(host(), version), { ok: true, version })
  }
})

test('a different or unknown runtime stays inactive', () => {
  for (const version of ['0.2.2-rc.1', '0.2.1', '0.3.0-rc.1', '0.3.0', '1.0.0', '0.2.2-rc.02']) {
    assert.equal(runtimeSupported(version), false, version)
    assert.equal(assessHost(host(), version).ok, false, version)
  }
  assert.match(assessHost(host(), undefined).reason, /unknown/)
})

test('a missing or longer child-wait method stays inactive', () => {
  assert.match(assessHost({ subagents: { rootOf() {} } }, '0.2.2-rc.5').reason, /waitForTreeWork/)
  assert.match(assessHost(host(2), '0.2.2-rc.5').reason, /arguments/)
  assert.match(assessHost({ subagents: { waitForTreeWork() {} } }, '0.2.2-rc.5').reason, /rootOf/)
})

test('an encoded file URL in a stack still resolves the host package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wait-reply-version-'))
  const spaced = join(root, 'DeepSeek Harness')
  const pkgDir = join(spaced, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  await mkdir(pkgDir, { recursive: true })
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '0.2.2-rc.5' }))
  const stack = `at Fiber.execute (file://${spaced.replaceAll(' ', '%20')}/node_modules/@deepseek-ai/cordis/lib/index.js:362:24)`
  assert.equal(hostVersionFromText(stack), '0.2.2-rc.5')
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
