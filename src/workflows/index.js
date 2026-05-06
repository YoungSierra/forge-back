const path = require('path')

const WORKFLOWS = {
  'z-image-turbo': {
    file: path.join(__dirname, 'z-image-turbo.json'),
    inject: {
      prompt: { node: '57:27', field: 'text' },
      width:  { node: '57:13', field: 'width' },
      height: { node: '57:13', field: 'height' },
      seed:   { node: '57:3',  field: 'seed' },
    },
  },
}

function getWorkflow(name) {
  const entry = WORKFLOWS[name]
  if (!entry) throw new Error(`Unknown ComfyUI workflow: "${name}". Available: ${Object.keys(WORKFLOWS).join(', ')}`)
  const template = require(entry.file)
  const workflow = JSON.parse(JSON.stringify(template))
  return { workflow, inject: entry.inject }
}

module.exports = { getWorkflow }
