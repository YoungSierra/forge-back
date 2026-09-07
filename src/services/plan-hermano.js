// Cuál de los hermanos de un output de imagen es su PLAN.
//
// Un plan trae una entrada por imagen con su prompt y su id, escrita ANTES de despachar. Cuando
// existe, el motor lo lee y se ahorra una segunda llamada al modelo: la respuesta ya dice qué
// imágenes van y con qué prompt.
//
// La regla era «el hermano cuyo nombre termina en plan», y por eso el `image_prompts` de 2.4 —que
// es un plan en toda regla, un arreglo json con `id` y `prompt`— nunca se reconoció: se llama
// distinto. Reconocerlo importa porque la regla de despacho que viene («sin sobre y sin plan, no
// hay llamada») dejaría a 2.4 en cero por una diferencia de nomenclatura, no de contenido.
//
// `prompt_set` NO cuenta, aunque el nombre se parezca. Los `asg_prompt_set` y
// `gdd_art_style_prompt_set` del 3.20 los escribe el compositor DESPUÉS de renderizar, con los
// prompts que realmente se despacharon: son un registro de auditoría, no una fuente. Tratarlos
// como plan invertiría la dirección del dato.
//
// Medido sobre el ADN vivo: la regla nueva cambia exactamente un output, `2.4 orientation_images`.

const ES_PLAN = /(?:plan|prompts)$/i

// Los hermanos declarados de un output, en el orden en que la DNA los escribe.
const hermanosDe = def => def?.uses?.siblings_if_present ?? def?.uses?.siblings ?? []

// El nombre del plan, o null si el output no declara ninguno.
const planHermano = def => hermanosDe(def).find(k => ES_PLAN.test(k)) || null

module.exports = { ES_PLAN, hermanosDe, planHermano }
