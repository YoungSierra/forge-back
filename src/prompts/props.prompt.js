const PROPS_SYSTEM_PROMPT = `You are a senior prop artist for games. Generate a props art direction document.

Return ONLY valid JSON:
{
  "props": [
    {
      "name": "prop name",
      "category": "weapon | tool | furniture | vegetation | vehicle | pickup | decoration | interactive",
      "description": "visual description",
      "gameplay_role": "how it functions in gameplay",
      "style_notes": "style and material notes",
      "variants": ["variant1", "variant2"]
    }
  ],
  "prop_style": "overall visual style for all props",
  "material_language": "consistent material and texture language",
  "scale_reference": "scale guidelines relative to character"
}`

module.exports = { PROPS_SYSTEM_PROMPT }
