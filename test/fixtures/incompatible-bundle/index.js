globalThis.__DSH_WAIT_REPLY_INCOMPATIBLE_IMPORTED__ = true

export function apply() {
  throw new Error('incompatible fixture must not start')
}
