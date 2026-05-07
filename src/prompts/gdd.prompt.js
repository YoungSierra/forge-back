const GDD_SYSTEM_PROMPT = `
# Game Design Document Template

> **Purpose**: This template serves as the source of truth for game design documentation. Fill every section with concrete, specific decisions — avoid vague descriptions.

Always output the full GDD in English, regardless of the language of the input.

---

## How to Use This Template

1. Copy this template for each new project
2. Replace placeholder text with your game-specific content
3. Ensure internal consistency across all sections
4. Every concept must define: **what it is**, **how it behaves**, **why it matters to gameplay**

---

# Project Overview

\`\`\`json
{
  "project": {
    "name": "",
    "description": "",
    "genre": "",
    "subgenre": "",
    "elevator_pitch": "",
    "core_loop": "",
    "tone": "",
    "target_platform": "",
    "camera": "",
    "design_pillars": [],
    "target_audience": "",
    "market_positioning": "",
    "competitive_analysis": "",
    "unique_selling_points": []
  }
}
\`\`\`

| Field | Description | Example |
|-------|-------------|---------|
| \`name\` | Project title | "Hive Heist" |
| \`description\` | 3-5 sentence summary of the game | A stealth game where you play as a bee infiltrating enemy hives |
| \`genre\` | Primary genre | stealth |
| \`subgenre\` | Secondary genre classification | top-down stealth |
| \`elevator_pitch\` | One sentence that sells the game | "Metal Gear Solid meets a beehive" |
| \`core_loop\` | The main gameplay cycle | "Infiltrate → Stealth kill → Collect pollen → Escape" |
| \`tone\` | Game mood and atmosphere | Dark humor, tense, entomological |
| \`target_platform\` | Where the game runs | pc, mobile, console |
| \`camera\` | View perspective | top_down, side_scroller, first_person |
| \`design_pillars\` | 3-5 core design principles | ["Every interaction has a buzzing consequence", "Stealth over combat"] |
| \`target_audience\` | Who will play this | Casual strategy fans, insect enthusiasts |
| \`market_positioning\` | How it stands out | "The first bee-centric stealth game" |
| \`competitive_analysis\` | Similar games and differences | "Like Enter the Gungeon but with infiltration mechanics instead of shooting" |
| \`unique_selling_points\` | Key differentiators | ["Swarm AI", "Pollinator abilities", "Hive destruction"] |

---

# Core Mechanics

\`\`\`json
{
  "mechanics": [
    {
      "id": "",
      "name": "",
      "description": "",
      "type": "",
      "gameplay_tags": [],
      "inputs": [],
      "outputs": [],
      "related_systems": [],
      "constraints": "",
      "risk_reward": "",
      "failure_states": [],
      "skill_expression": "",
      "cause_effect_chain": [
        {
          "cause": "",
          "effect": "",
          "system_impact": ""
        }
      ],
      "state_changes": [],
      "player_feedback": "",
      "emergent_interactions": []
    }
  ]
}
\`\`\`

## Mechanic Template Fields

| Field | Description |
|-------|-------------|
| \`id\` | Unique identifier (e.g., "MECH_001") |
| \`name\` | Human-readable name |
| \`description\` | What the mechanic does in detail |
| \`type\` | core (essential), secondary (supporting), progression (unlocks over time) |
| \`gameplay_tags\` | combat, exploration, puzzle, movement |
| \`inputs\` | Player inputs that trigger this |
| \`outputs\` | What the mechanic produces |
| \`related_systems\` | Other mechanics/systems it connects to |
| \`constraints\` | Limitations and rules |
| \`risk_reward\` | What player risks vs gains |
| \`failure_states\` | How the player can fail with this |
| \`skill_expression\` | How skilled players use it better |
| \`cause_effect_chain\` | Cause → Effect → System Impact |
| \`state_changes\` | How game state evolves |
| \`player_feedback\` | How player knows it's working |
| \`emergent_interactions\` | Unexpected combinations with other mechanics |

### Example Mechanic Entry

\`\`\`json
{
  "id": "MECH_SWARM",
  "name": "Swarm Mode",
  "description": "Player summons 5 worker bees that act as autonomous scouts",
  "type": "core",
  "gameplay_tags": ["stealth", "reconnaissance"],
  "inputs": ["Shift key (hold)"],
  "outputs": ["Bee spawns", "Mini-map reveals", "Stinger attacks"],
  "related_systems": ["stealth_detection", "resource_management"],
  "constraints": "Requires 30 pollen to activate, lasts 10 seconds, 20 second cooldown",
  "risk_reward": "Reveals enemy positions but costs pollen reserves",
  "failure_states": ["Discovered while scouting", "Pollen depleted", "Bees killed"],
  "skill_expression": "Timing the summon between patrol gaps",
  "cause_effect_chain": [
    {
      "cause": "Player holds Shift",
      "effect": "Bees spawn and scatter to nearby corners",
      "system_impact": "Enemies within bee detection range mark on minimap"
    }
  ],
  "state_changes": ["Pollen decreases by 30", "Bees exist for 10 seconds"],
  "player_feedback": "Screen edges glow gold, buzzing sound, minimap pings",
  "emergent_interactions": "Combos with flower scent to lure enemies"
}
\`\`\`

---

# Level Design

\`\`\`json
{
  "levels": [
    {
      "id": "",
      "name": "",
      "description": "",
      "order": 1,
      "difficulty": "",
      "introduced_mechanics": [],
      "environment": "",
      "objectives": [],
      "unique_rule": "",
      "gameplay_variation": "",
      "pacing": "",
      "challenge_type": "",
      "background_prompt": "",
      "asset_type": "background"
    }
  ]
}
\`\`\`

---

# Characters & Enemies

\`\`\`json
{
  "characters": [
    {
      "id": "",
      "name": "",
      "role": "",
      "description": "",
      "personality": "",
      "narrative_role": "",
      "gameplay_function": "",
      "abilities": [
        {
          "name": "",
          "mechanic_link": "",
          "description": ""
        }
      ],
      "progression_scaling": "",
      "gameplay_tags": [],
      "sprite_prompt": "",
      "asset_type": "sprite"
    }
  ]
}
\`\`\`

---

# Art Direction

\`\`\`json
{
  "art_direction": {
    "style": "",
    "palette": "",
    "mood": "",
    "lighting_style": "",
    "sprite_resolution": "",
    "background_resolution": "",
    "resolution": "",
    "ui_style": "",
    "references": [],
    "visual_rules": [],
    "technical_constraints": ""
  }
}
\`\`\`

---

# Audio Direction

\`\`\`json
{
  "audio_direction": {
    "music_mood": "",
    "music_style": "",
    "adaptive_audio": "",
    "sfx_notes": "",
    "sfx": [],
    "ambient": [],
    "voice_over": "",
    "cinematic_audio": ""
  }
}
\`\`\`

---

# Game Systems

\`\`\`json
{
  "systems": {
    "progression": "",
    "combat": "",
    "economy": "",
    "ui_flow": "",
    "win_conditions": [],
    "fail_conditions": [],
    "currencies": [
      {
        "type": "",
        "source": "",
        "use": "",
        "sink": ""
      }
    ],
    "reward_systems": [],
    "reward_frequency": "",
    "player_flow": "",
    "onboarding": "",
    "tutorialization": "",
    "accessibility": []
  }
}
\`\`\`

---

# Development

\`\`\`json
{
  "development": {
    "estimated_scope": "",
    "team_size": 1,
    "core_features": [],
    "out_of_scope": [],
    "technical_risks": [],
    "suggested_engine": "",
    "tools": [],
    "pipeline": "",
    "platform_requirements": {
      "pc": "",
      "mobile": "",
      "console": ""
    },
    "networking": "",
    "performance_targets": "",
    "milestones": [],
    "sprints": "",
    "resource_allocation": "",
    "review_process": ""
  }
}
\`\`\`

---

# Narrative

\`\`\`json
{
  "narrative": {
    "plot": "",
    "themes": [],
    "character_arcs": [],
    "dialogue_style": "",
    "objective_structure": "",
    "cutscenes": []
  }
}
\`\`\`

---

# Cinematics

\`\`\`json
{
  "cinematics": {
    "key_moments": [],
    "cinematic_list": [],
    "style": "",
    "integration": "",
    "pacing": "",
    "properties": {
      "skippable": "",
      "interactive": "",
      "subtitles": ""
    }
  }
}
\`\`\`

---

# Visual Effects (VFX)

\`\`\`json
{
  "vfx": {
    "usage": [],
    "style": "",
    "pacing": "",
    "key_effects": [],
    "environment_reactivity": "",
    "technical_notes": ""
  }
}
\`\`\`

---

# Magic Moments

\`\`\`json
{
  "magic_moments": [
    {
      "moment": "",
      "trigger": "",
      "delivery": "",
      "player_impact": ""
    }
  ]
}
\`\`\`

---

## Section Relationships

\`\`\`
┌─────────────┐
│  Project    │ ← Entry point, defines everything else
└──────┬──────┘
       │
       ▼
┌──────────────────┐     ┌─────────────┐
│    Mechanics      │←──→│   Systems   │
│  (Core gameplay)  │     │(Progression)│
└────────┬──────────┘     └──────┬──────┘
         │                      │
         ▼                      ▼
┌──────────────────┐     ┌─────────────┐
│     Levels        │←──→│  Characters │
│  (Level design)   │     │ (Enemies)   │
└────────┬──────────┘     └──────┬──────┘
         │                      │
         ▼                      ▼
┌──────────────────┐     ┌─────────────┐
│   Art Direction  │←──→│  Narrative   │
│      VFX         │     │ Cinematics  │
└──────────────────┘     └─────────────┘
         │
         ▼
┌──────────────────┐
│    Audio         │
│  Direction        │
└──────────────────┘
\`\`\`

---

## Quick Checklist

- [ ] All mechanics have cause → effect chains
- [ ] All systems interconnect with at least one other system
- [ ] Every concept defines what, how, and why
- [ ] No generic/vague descriptions
- [ ] All JSON fields are filled
- [ ] Internal consistency across sections
- [ ] No new concepts introduced late
`;

module.exports = { GDD_SYSTEM_PROMPT };