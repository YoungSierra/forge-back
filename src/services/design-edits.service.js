// ─── Design Edits V2: la referencia de Dirección de Arte en la IMAGE 2 (v2.9.61) ─────────────────────────
//
// El registro del workflow (`V57_STUDIO_Moodboard_Iteration_V2`, al lado de la V1; ver `workflowDeDesignEdit`) declara la ranura de la referencia como un hueco
// más de `inject_config.image_inputs` —{ node "30", slot "2", resolve "page_instance" }, los mismos nombres que
// USERREF del ASG— y el texto que va en `{{REFERENCE_SCOPE}}` según el chip, en `inject_config.reference_scope`.
// Nada de eso se escribe acá: se lee del registro.
//
// Sin referencia (requisito de Pedro, condición del despliegue) no va la IMAGE 2 y el prompt pierde todo lo que
// habla de ella: la línea «IMAGE 2 = …», la frase «If IMAGE 2 …», el bloque «HOW TO USE THE REFERENCE …» entero y
// la cabecera pasa a «ONE input image». El resultado tiene que ser byte a byte el `prompt_sin_referencia.txt` de
// su paquete; lo comprueba `scripts/prueba-design-edits-v2.js`.
//
// Un registro sin esos huecos —el V1 de 3 nodos, o tras un `--restore`, o New Art Style— no entra en nada de esto:
// el grafo sale exactamente como antes.
'use strict'

const { esUserref } = require('../utils/userref')

/** El hueco de la referencia de Dirección de Arte del registro, o null si este workflow no lo tiene. */
function huecoDeReferencia(cfg) {
  return (cfg?.image_inputs || []).find(esUserrefDE) || null
}
// En Design Edits la referencia va en la IMAGE 2, no en la 3: lo que la reconoce es `resolve`, no el número.
const esUserrefDE = h => h?.resolve === 'page_instance' || esUserref(h)

/** El prompt sin todo lo que habla de la IMAGE `slot`: sus líneas, el bloque de cómo usarla y la cabecera. */
function sinReferencia(prompt, slot = '2') {
  if (typeof prompt !== 'string') return prompt
  const img = `IMAGE ${slot}`
  const lineas = prompt.split('\n')
  const fuera = []
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i]
    if (l.startsWith(`${img} = `) || l.startsWith(`If ${img} `)) continue
    // El bloque «HOW TO USE THE REFERENCE …» hasta su línea en blanco, ella incluida.
    if (/^HOW TO USE THE REFERENCE\b/.test(l)) {
      while (i < lineas.length && lineas[i].trim() !== '') i++
      continue
    }
    fuera.push(l)
  }
  const cuantas = { 2: ['TWO input images', 'ONE input image'], 3: ['THREE input images', 'TWO input images'] }[slot]
  const texto = fuera.join('\n')
  return cuantas ? texto.replace(`You are given ${cuantas[0]}.`, `You are given ${cuantas[1]}.`) : texto
}

/** El texto del alcance según el chip (`cambio`: tratamiento → look, sujeto → design), o null si el chip no aplica. */
function textoDeAlcance(cfg, cambio) {
  const valores = cfg?.reference_scope?.values || {}
  const v = Object.values(valores).find(x => x?.cambio && x.cambio === cambio)
  return v ? { clave: Object.keys(valores).find(k => valores[k] === v), texto: v.text ?? '' } : null
}

/**
 * Deja el grafo listo para despachar. Puro: no lee la base ni la red.
 *   · `pedido` va en el token del usuario (`inject_config.prompt.token`).
 *   · `subidaRef` = el nombre en ComfyUI de la referencia, o null si va sin ella.
 * Devuelve `{ alcance }`: 'look' | 'design' con referencia, null sin ella.
 */
function prepararGrafo({ wf, cfg, pedido, cambio = null, subidaRef = null }) {
  const hueco = huecoDeReferencia(cfg)
  let alcance = null

  if (hueco && cfg.prompt?.node) {
    const nodoPrompt = wf[cfg.prompt.node]
    const campo = cfg.prompt.field
    const token = cfg.reference_scope?.token || '{{REFERENCE_SCOPE}}'
    let texto = String(nodoPrompt.inputs[campo] || '')
    if (subidaRef) {
      const a = textoDeAlcance(cfg, cambio)
      if (!a) {
        const e = new Error('Choose what you are changing («How it looks» or «What it shows»): with a reference it decides what is taken from it')
        e.status = 400; e.publico = true; e.code = 'FALTA_CHIP'
        throw e
      }
      alcance = a.clave
      wf[hueco.node].inputs.image = subidaRef
      texto = texto.split(token).join(a.texto)
    } else {
      // Sin referencia: fuera la ranura (y su LoadImage) y fuera del prompt todo lo que habla de ella.
      for (const [k, v] of Object.entries(nodoPrompt.inputs)) {
        if (Array.isArray(v) && String(v[0]) === String(hueco.node)) delete nodoPrompt.inputs[k]
      }
      delete wf[hueco.node]
      texto = sinReferencia(texto, String(hueco.slot)).split(token).join('')
    }
    nodoPrompt.inputs[campo] = texto
  }

  // El token, no el prompt entero: el andamiaje de alrededor es lo que protege la plantilla.
  if (cfg.prompt?.node) {
    const campo = cfg.prompt.field
    const base  = String(wf[cfg.prompt.node].inputs[campo] || '')
    const token = cfg.prompt.token || '[ USER PROMPT ]'
    wf[cfg.prompt.node].inputs[campo] = base.includes(token)
      ? base.split(token).join(pedido)
      : `${pedido}\n\n${base}`   // si alguien quita el token, el pedido igual llega
  }
  return { alcance }
}

// ── Qué fila corre: V1 o V2 ──────────────────────────────────────────────────
//
// El v2.9.61 no toca la fila de hoy: registra `V57_STUDIO_Moodboard_Iteration_V2` al lado, igual que el `_25` y
// el `_31` del ASG (decisión de Pedro, 22-10). Va a la V2 solo una página del ASG —fija o instanciada— de un
// proyecto NUEVO; un proyecto viejo, o una imagen que no es del ASG, siguen en la V1 exactamente como hoy.
//
// «Nuevo» con la misma regla que `maestroDelProyecto`: creado DESPUÉS de que se registró la fila V2. La fecha se
// lee del propio registro, sin número mágico; sin la fila V2 registrada, todo va a la V1.
const DESIGN_EDITS_V1 = 'V57_STUDIO_Moodboard_Iteration'
const DESIGN_EDITS_V2 = 'V57_STUDIO_Moodboard_Iteration_V2'

async function workflowDeDesignEdit({ db, project_id, asset }) {
  const { destinoDeAsset } = require('./referencias-ad.service')
  if (!destinoDeAsset(asset)) return { workflow: DESIGN_EDITS_V1, motivo: 'not an Art Style Guide page' }
  const [{ data: p }, { data: v2 }] = await Promise.all([
    db().from('projects').select('created_at').eq('id', project_id).maybeSingle(),
    db().from('comfyui_workflows').select('created_at').eq('name', DESIGN_EDITS_V2).eq('is_active', true).maybeSingle(),
  ])
  if (!v2?.created_at) return { workflow: DESIGN_EDITS_V1, motivo: 'V2 not registered' }
  if (!p?.created_at || new Date(p.created_at) <= new Date(v2.created_at)) return { workflow: DESIGN_EDITS_V1, motivo: 'project older than V2' }
  return { workflow: DESIGN_EDITS_V2, motivo: 'Art Style Guide page of a new project' }
}

// ── Generation options de la V2 ──────────────────────────────────────────────
//
// La rev. 4 de Art Direction pide TODOS los parámetros del nodo editables en Design Edits V2. La lista general
// (workflow-options) deja fuera `background`, `n` y `seed` a propósito para el resto de los workflows —la semilla
// la sortea el motor y n multiplica el gasto—; acá se suman. Con n > 1 el usuario elige entre las n imágenes.
// Ojo: en el nodo de OpenAI, `seed` dice «not implemented yet in backend» (object_info, 22-10): se puede fijar, pero
// no hace repetible la imagen.
const EXTRA_V2 = ['background', 'n', 'seed']
const opcionesExtraDe = cfg => (huecoDeReferencia(cfg) ? EXTRA_V2 : null)

module.exports = { huecoDeReferencia, sinReferencia, textoDeAlcance, prepararGrafo, workflowDeDesignEdit, opcionesExtraDe, DESIGN_EDITS_V1, DESIGN_EDITS_V2 }
