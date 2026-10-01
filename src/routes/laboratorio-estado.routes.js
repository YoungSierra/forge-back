// ─── Las dos rutas por las que el Laboratory guarda y recupera su estado ─────
//
// Van fuera de `/api/projects` a propósito. Ese prefijo está detrás de `requireAuth`, que exige el
// JWT de un usuario de Supabase, y quien llama acá no es una persona con sesión abierta: es otro
// servicio. Meterlas ahí obligaría a inventarle un usuario al Laboratory, que es peor que darle
// una llave propia.
//
// La llave es un secreto compartido en la cabecera. No es OAuth y no pretende serlo: son dos
// servicios nuestros hablando entre ellos, el secreto va por variable de entorno en los dos lados
// y no viaja nunca al navegador. Si falta la variable, estas rutas **se niegan a atender** en vez
// de quedarse abiertas — una puerta sin cerradura es peor que ninguna puerta.
//
// El Laboratory se identifica por SLUG, que es lo único que conoce. La traducción a proyecto la
// hace Forge.

const express = require('express')
const router = express.Router()
const { db } = require('../services/supabase.service')

const SECRETO = () => process.env.LAB_SHARED_SECRET || ''

function soloElLaboratorio(req, res, next) {
  const esperado = SECRETO()
  if (!esperado) {
    console.error('[lab-estado] LAB_SHARED_SECRET no está configurado: la ruta se niega')
    return res.status(503).json({ success: false, code: 'SIN_SECRETO',
      error: 'This Forge is not configured to receive Laboratory state' })
  }
  // Comparación de longitud fija: con `===` el tiempo de respuesta filtra cuántos caracteres
  // acertó quien prueba. Cuesta nada y quita el único ataque barato que tiene un secreto corto.
  const dado = String(req.get('x-lab-secret') || '')
  const a = Buffer.from(dado.padEnd(esperado.length).slice(0, esperado.length))
  const b = Buffer.from(esperado)
  const igual = dado.length === esperado.length && require('crypto').timingSafeEqual(a, b)
  if (!igual) return res.status(401).json({ success: false, code: 'SECRETO_INVALIDO', error: 'Not authorized' })
  next()
}

router.use(soloElLaboratorio)

// Guardar. Lo llama el Laboratory DESPUÉS de cada operación que cambia su estado — generate, chat
// y sync—, que son los tres sitios donde su disco deja de parecerse a lo guardado.
//
// El cuerpo puede ser grande: el TDD solo son 112 KB y el gameplay otros 78 KB. El límite se sube
// acá y no globalmente, para no abrirle la puerta a todo lo demás.
router.post('/estado', express.json({ limit: '25mb' }), async (req, res, next) => {
  try {
    const { guardarEstado } = require('../services/laboratorio-estado.service')
    const { slug, archivos, chat, origen } = req.body || {}
    if (!slug) return res.status(400).json({ success: false, error: 'slug required' })
    const r = await guardarEstado({ db, slug, archivos: archivos || [], chat: chat ?? null, origen: origen || null })
    res.json({ success: true, guardado_en: r.guardado_en, archivos: (r.archivos || []).length,
      bytes: r.bytes, chat_mensajes: r.chat_mensajes, descartados: r.descartados })
  } catch (err) {
    if (err.code === 'SIN_PROYECTO') return res.status(404).json({ success: false, code: err.code, error: err.message })
    if (err.code === 'SLUG_AMBIGUO') return res.status(409).json({ success: false, code: err.code, error: err.message })
    next(err)
  }
})

// Recuperar. Lo llama el Laboratory al activar un taller, antes de darlo por vacío.
//
// `?archivos=0` devuelve solo el resumen, para poder preguntar «¿hay algo guardado?» sin arrastrar
// doscientos kilobytes que a lo mejor no hacen falta.
router.get('/estado/:slug', async (req, res, next) => {
  try {
    const { leerEstado } = require('../services/laboratorio-estado.service')
    const conArchivos = req.query.archivos !== '0'
    res.json({ success: true, ...await leerEstado({ db, slug: req.params.slug, conArchivos }) })
  } catch (err) {
    if (err.code === 'SIN_PROYECTO') return res.status(404).json({ success: false, code: err.code, error: err.message })
    if (err.code === 'ESTADO_INCOMPLETO') return res.status(409).json({ success: false, code: err.code, error: err.message })
    next(err)
  }
})

module.exports = router
