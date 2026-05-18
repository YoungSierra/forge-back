/**
 * Reemplaza {{VAR_NAME}} en un template string con los valores del objeto vars.
 * Claves no encontradas se dejan intactas para facilitar el debug.
 */
function injectVars(template, vars = {}) {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value ?? ''),
    template
  )
}

module.exports = { injectVars }
