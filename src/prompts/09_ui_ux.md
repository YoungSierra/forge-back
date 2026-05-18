# GDD SECTION 9 — USER INTERFACE & UX
## File: 09_ui_ux.md

---

## PLACEHOLDERS (host-supplied)

| Placeholder | Value |
|-------------|--------|
| **System** | Full `rules.md` with `{{GAME_IDEA}}` replaced. |
| `{{PRIOR_CONTEXT}}` | **Required:** cumulative stored Markdown for **§1 … §8** in order (concatenate each prior section’s full output). This is the **only** cross-section context for §9 — do not rely on any separate summary file. |

---

## CONTEXT (inject below)

## PRIOR CONTEXT

{{PRIOR_CONTEXT}}

Treat everything in `{{PRIOR_CONTEXT}}` as authoritative when it overlaps with other memories of earlier sections.

---

## YOUR TASK

Write **Section 9: User Interface & UX** of the Game Design Document.

The UI philosophy must reflect the art style from Section 2.1. HUD elements should surface the resources and stats used by the mechanics in Section 5 — reference those mechanic names when describing what data the HUD displays. Controls must match the primary platform from Section 2.2. The tutorial approach should connect to the player journey from Section 3.4.

Output only Section 9. Start directly with the section header. Do not explain your process.

---

## OUTPUT TEMPLATE

## 9. USER INTERFACE & UX

### 9.1 UI Philosophy
[1–2 sentences describing the guiding principle of the interface design — how does the UI reflect the game's art style and serve the moment-to-moment experience?]

### 9.2 HUD Elements

| Element | Position | Information Displayed | Visibility |
|---------|----------|-----------------------|------------|
| [HUD element name] | [Top-left / Top-center / Bottom-right / etc.] | [What data it shows — reference mechanic names from Section 5 where relevant] | [Always visible / Contextual / Player-toggled] |
| [HUD element] | [position] | [data] | [visibility] |
| [HUD element] | [position] | [data] | [visibility] |
| [HUD element] | [position] | [data] | [visibility] |

### 9.3 Menu Structure

```
MAIN MENU
├── New Game
├── Continue
├── Settings
│   ├── Video
│   ├── Audio
│   ├── Controls
│   └── Accessibility
├── [Game-specific menu — e.g. Codex, Gallery, Records]
└── Quit

IN-GAME PAUSE MENU
├── Resume
├── [Game-specific option — e.g. Map, Journal, Inventory, Skill Tree]
├── Settings
├── Save Game
└── Return to Main Menu
```

### 9.4 Controls

**Keyboard & Mouse**

| Input | Action |
|-------|--------|
| [Key / Mouse button] | [Specific action — reference mechanic from Section 5 if applicable] |
| [Key] | [Action] |
| [Key] | [Action] |
| [Key] | [Action] |
| [Key] | [Action] |
| [Key] | [Action] |

**Controller (Xbox layout)**

| Input | Action |
|-------|--------|
| [Button / Stick / Trigger] | [Action] |
| [Button / Stick] | [Action] |
| [Button / Stick] | [Action] |
| [Button / Stick] | [Action] |
| [Button / Stick] | [Action] |

### 9.5 Onboarding & Tutorial
[How does the game teach the player without a separate tutorial screen? What does the first 15 minutes communicate, and how? What is the first moment of genuine player agency? How does the difficulty curve in the onboarding connect to Phase 1 of the player journey from Section 3.4?]

### 9.6 Accessibility Features
- [Feature 1 — e.g. Fully remappable controls on all platforms]
- [Feature 2 — e.g. Subtitles with speaker identification and adjustable size]
- [Feature 3 — e.g. Colorblind modes: Protanopia, Deuteranopia, Tritanopia]
- [Feature 4]
- [Feature 5]
