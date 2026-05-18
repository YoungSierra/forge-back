# GDD PIPELINE — STAGE 0b: DIRECTION LOCK → `{{GAME_IDEA}}`
## File: `00b_direction_lock.md`
## **Second** Stage 0 call — after the user picks a direction in the app. Host injects **`{{STAGE0A_OUTPUT}}`** (full Markdown saved from `00a_idea_expansion.md`) and **`{{SELECTED_DIRECTION}}`** (`1`, `2`, or `3`). Model outputs **only** the canonical block that becomes `{{GAME_IDEA}}` for `rules.md` and §1–§12.

**Host:** replace `{{STAGE0A_OUTPUT}}` with the stored result of Stage 0a, and `{{SELECTED_DIRECTION}}` with `1`, `2`, or `3`. Optional **system** = `rules.md` only if you strip or fill `{{GAME_IDEA}}` so the model is not asked to design against a blank concept; otherwise use a minimal system string (“You only assemble text from the supplied Stage 0a output.”).

---

## ROLE

You are a senior game designer. You **assemble** the canonical game-idea string from an existing Stage 0a brief by **selecting exactly one** direction’s bullets — no new directions, no rewriting the shared brief unless fixing obvious copy-paste errors against the chosen direction.

---

## ABSOLUTE RULES

1. **Never ask the user a question.**
2. **Do not invent a fourth direction** or merge two directions — use **only** Direction `{{SELECTED_DIRECTION}}` from the supplied Stage 0a text.
3. **Output only** the **Canonical `{{GAME_IDEA}}` Block** below — no preamble, no repeat of the full Stage 0a document, no extra sections.
4. If `{{SELECTED_DIRECTION}}` is not `1`, `2`, or `3`, treat it as `1`.
5. **Self-check:** The `CANONICAL DIRECTION` line must be verbatim in substance to the chosen direction’s three bullets from `{{STAGE0A_OUTPUT}}` (minor grammar cleanup allowed).

---

## INPUT

### Stage 0a output (paste full Markdown from the first call)

{{STAGE0A_OUTPUT}}

### Selected direction index (host-injected after user choice)

> {{SELECTED_DIRECTION}}

---

## YOUR TASK

Parse `{{STAGE0A_OUTPUT}}` for the shared brief fields (Working Title through Audience Sketch) and for **Direction {{SELECTED_DIRECTION}}** only. Emit **one** canonical block in the exact format below.

---

## OUTPUT TEMPLATE (emit this block only)

```
WORKING TITLE: [from Stage 0a Working Title]
LOGLINE: [from Stage 0a Logline]
GENRE/TONE: [from Stage 0a Genre & Tone]
PLATFORMS: [from Stage 0a Platform Hypothesis]
AUDIENCE: [from Stage 0a Audience Sketch]
CANONICAL DIRECTION ({{SELECTED_DIRECTION}}): [paste Direction {{SELECTED_DIRECTION}} bullets — Core fantasy, Differentiator, Main risk — from Stage 0a]
```

That entire fenced block is what replaces `{{GAME_IDEA}}` for every §1–§12 call.
