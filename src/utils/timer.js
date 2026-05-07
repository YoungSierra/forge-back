function makeTimer(label) {
  const t0 = Date.now()
  let last = t0
  return {
    lap(step) {
      const now = Date.now()
      console.log(`[${label}] ✓ ${step.padEnd(26)} ${String(now - last).padStart(5)}ms`)
      last = now
    },
    end() {
      console.log(`[${label}] ■ total ${''.padEnd(26)} ${String(Date.now() - t0).padStart(5)}ms`)
    },
  }
}

module.exports = { makeTimer }
