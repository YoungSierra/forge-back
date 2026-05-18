# GDD SECTION 11 — GAME ECONOMY & REWARDS
## File: 11_economy.md

---

## PLACEHOLDERS (host-supplied)

| Placeholder | Value |
|-------------|--------|
| **System** | Full `rules.md` with `{{GAME_IDEA}}` replaced. |
| `{{PRIOR_CONTEXT}}` | **Required:** cumulative stored Markdown for **§1 … §10** in order (concatenate each prior section’s full output). |

---

## CONTEXT (inject below)

## PRIOR CONTEXT

{{PRIOR_CONTEXT}}

Treat everything in `{{PRIOR_CONTEXT}}` as authoritative when it overlaps with other memories of earlier sections.

---

## YOUR TASK

Write **Section 11: Game Economy & Rewards** of the Game Design Document.

The monetization model must be appropriate for the platform established in Section 2.2 and the target audience from Section 1.3. Reward triggers in Section 11.3 should align with the core loop steps from Section 4.2 and the unlockables from Section 6.5. Currency names should feel like they belong to this specific game world.

Output only Section 11. Start directly with the section header. Do not explain your process.

---

## OUTPUT TEMPLATE

## 11. GAME ECONOMY & REWARDS

### 11.1 Monetization Model
**Model:** [Premium / Free-to-Play / Buy-to-Play + DLC / Early Access / Subscription]
**Price point:** [e.g. $29.99 on PC (Steam) / Free on mobile]
**Description:** [2–3 sentences explaining the full monetization strategy, why it fits the platform and audience, and what the post-launch revenue plan looks like]

### 11.2 Currencies

| Currency | Type | How Earned | How Spent | Purchasable? |
|----------|------|------------|-----------|--------------|
| [Name — should fit the game world] | Soft | [Specific methods — e.g. completing quests, defeating enemies, exploration] | [What it buys — reference unlockables from Section 6.5] | No |
| [Name] | Hard / Premium | [Methods or direct purchase] | [What it buys — cosmetics, time-savers, etc.] | [Yes — $X per Y units / No] |

### 11.3 Reward Structure

| Reward Type | Trigger | Frequency | Emotion Targeted |
|-------------|---------|-----------|-----------------|
| [e.g. XP gain] | [Specific trigger — e.g. every completed combat encounter] | [Constant / Frequent / Rare] | [Specific emotion — e.g. progress, momentum, anticipation] |
| [Reward type] | [Trigger — reference loop step from Section 4.2 if applicable] | [Frequency] | [Emotion] |
| [Reward type] | [Trigger] | [Frequency] | [Emotion] |
| [Reward type] | [Trigger] | [Frequency] | [Emotion] |

### 11.4 Economy Balance Notes
- [Balance consideration 1 — e.g. Soft currency inflation is controlled by capping daily earn rates and introducing gold sinks at the mid-game phase]
- [Balance consideration 2 — e.g. Premium currency is never required for gameplay progression, only cosmetic items]
- [Balance consideration 3 — specific to this game's economy design]
