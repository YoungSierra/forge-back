# GDD SECTION 10 — ART DIRECTION & AUDIO
## File: 10_art_audio.md

---

## PLACEHOLDERS (host-supplied)

| Placeholder | Value |
|-------------|--------|
| **System** | Full `rules.md` with `{{GAME_IDEA}}` replaced. |
| `{{PRIOR_CONTEXT}}` | **Required:** cumulative stored Markdown for **§1 … §9** in order (concatenate each prior section’s full output). |

---

## CONTEXT (inject below)

## PRIOR CONTEXT

{{PRIOR_CONTEXT}}

Treat everything in `{{PRIOR_CONTEXT}}` as authoritative when it overlaps with other memories of earlier sections.

---

## YOUR TASK

Write **Section 10: Art Direction & Audio** of the Game Design Document.

All visual descriptions must be consistent with the art style established in Section 2.1. The environment visual style must align with the environments described in Section 7.7. Character visual style must match the appearance fields in Section 8. Technical visual targets must be realistic for the platform from Section 2.2. The "Magic Moments" should reference specific events or locations already established in Sections 7–8.

Output only Section 10. Start directly with the section header. Do not explain your process.

---

## OUTPUT TEMPLATE

## 10. ART DIRECTION & AUDIO

### 10.1 Visual Identity
[3–4 sentences describing the overall visual character of the game. What does this game look like at a glance? What emotion does the art evoke? How would you describe it to someone who has never seen it?]

### 10.2 Art Style References

| Reference | What We Take From It |
|-----------|----------------------|
| [Game / Film / Artist / Artwork] | [Specific visual quality to borrow — not "the overall vibe" but a precise element like lighting, silhouette design, texture density, color temperature] |
| [Reference] | [Specific quality] |
| [Reference] | [Specific quality] |

### 10.3 Color Palette

| Role | Color Description | Tone | Usage |
|------|------------------|------|-------|
| Primary | [e.g. Deep slate blue, desaturated] | [Dark / Mid / Light] | [Where this color appears — environments, UI base, etc.] |
| Secondary | [description] | [tone] | [usage] |
| Accent | [description] | [tone] | [usage] |
| Danger / Alert | [description] | [tone] | [usage] |

### 10.4 Character Visual Style
[How are characters rendered? Proportions, level of detail, silhouette priority, outfit design language. Must be consistent with character appearance descriptions in Section 8.]

### 10.5 Environment Visual Style
[How do environments look? Lighting approach, texture density, color grading, sense of scale. Must be consistent with environment descriptions in Section 7.7.]

### 10.6 Technical Visual Targets
- **Target resolution:** [e.g. 4K with dynamic scaling on PC / 1440p on console]
- **Frame rate target:** [e.g. 60 fps locked, 120 fps mode on capable hardware]
- **Rendering pipeline:** [e.g. URP, HDRP, deferred rendering — must match engine from Section 12.1]
- **Key visual effects:** [List 3–5 specific VFX that define the visual experience of this game]

### 10.7 Music & Sound Design

| Element | Description |
|---------|-------------|
| Music Genre | [Genre and emotional register — be specific, e.g. "orchestral with electronic percussion" not just "epic"] |
| Instrumentation | [Key instruments or sound palette that define the game's sonic identity] |
| Adaptive Music | [How music responds to gameplay state — combat vs. exploration vs. story moments] |
| Sound Design Style | [Realistic / Stylized / Hybrid — and 2–3 key sounds that will define the game's audio identity] |
| Voice Over | [Full VO / Partial / None — and the performance style and language] |
| Ambience | [How environmental audio builds atmosphere in different locations from Section 7.7] |

### 10.8 Magic Moments
[3–5 specific moments designed to be unforgettable — scenes players will describe to friends. Reference specific locations or characters from Sections 7–8.]

1. **[Moment name]** — [What triggers it, what the player sees and hears, and exactly why it lands emotionally]
2. **[Moment name]** — [description]
3. **[Moment name]** — [description]
