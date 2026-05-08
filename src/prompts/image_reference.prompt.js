const IMAGE_REFERENCE_PROMPT_TEMPLATE = `Create a new character based on the following concept: [INSERT CHARACTER DESCRIPTION].

Visual style: [INSERT CHARACTER STYLE].

Optional context / role / theme: [INSERT OPTIONAL CONTEXT].

The character must be designed with a highly cohesive and internally consistent visual identity, as if it belongs to a single polished stylized universe. The design must feel unified in proportions, form language, silhouette, materials, color, lighting, and finish.

Respect these character construction rules:
- consistent proportions between head, torso, arms, and legs
- clear and readable silhouette
- unified shape language
- controlled stylization
- clean and intentional design
- consistent material treatment
- harmonious color palette
- polished render quality

Maintain strict consistency in:
- head, body, and limb scale
- shape language (curves vs. angles)
- level of simplification
- silhouette clarity
- color palette and chromatic harmony
- material treatment
- lighting and render style
- stylization level

The visual style must follow this direction consistently:
- preserve the intended style described in [INSERT CHARACTER STYLE]
- ensure the character fully reflects that style in proportions, shape language, materials, rendering, and finish
- do not deviate into a different aesthetic language
- do not mix unrelated visual influences

Do not make the character more realistic or more cartoonish than the rest of the design.
Do not mix different visual languages.
Do not introduce unrelated stylistic influences.

The character MUST be in a strict T-pose:
front-facing, perfectly centered, arms fully extended horizontally at shoulder height, straight and symmetrical, no bending, no rotation, no gesture, no variation in pose.

The body must remain upright, rigid, and fully aligned, with a neutral stance and identical left and right balance.

The background MUST be pure white, completely clean and seamless, with no gradients, no environment, no props, and no additional elements.
Only a very subtle grounding shadow under the feet is allowed.

The final result must feel like a production-ready character design from one single consistent visual universe.`

module.exports = { IMAGE_REFERENCE_PROMPT_TEMPLATE }
