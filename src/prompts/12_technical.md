# GDD SECTION 12 — TECHNICAL SPECIFICATIONS
## File: 12_technical.md

---

## PLACEHOLDERS (host-supplied)

| Placeholder | Value |
|-------------|--------|
| **System** | Full `rules.md` with `{{GAME_IDEA}}` replaced. |
| `{{PRIOR_CONTEXT}}` | **Required:** cumulative stored Markdown for **§1 … §11** in order (concatenate each prior section’s full output). |

---

## CONTEXT (inject below)

## PRIOR CONTEXT

{{PRIOR_CONTEXT}}

Treat everything in `{{PRIOR_CONTEXT}}` as authoritative when it overlaps with other memories of earlier sections.

---

*Host:* when all **§1–§12** outputs exist in your app, concatenate them in order for the final GDD export.

---

## YOUR TASK

Write **Section 12: Technical Specifications** of the Game Design Document.

The engine and rendering pipeline must support the visual targets from Section 10.6. PC requirements must be realistic for the art style and platform from Sections 2.1–2.2. The art pipeline must match the technical form (2D/3D) from Section 2.1. Custom systems to develop should address gaps in off-the-shelf tooling for the specific mechanics from Section 5. Networking requirements must address the player mode from Section 2.1.

This is the final section. Before outputting it, do a full self-check:
- Is the game title consistent across `{{PRIOR_CONTEXT}}`?
- Does the platform in Section 2 match the PC specs you are about to write?
- Does the rendering pipeline match the engine you are choosing?
- Are there any fields in prior sections that still contain brackets?

Output only Section 12. Start directly with the section header. Do not explain your process.

---

## OUTPUT TEMPLATE

## 12. TECHNICAL SPECIFICATIONS

### 12.1 Engine & Tools

| Category | Tool / Technology |
|----------|------------------|
| Game Engine | [Engine + version — must support the rendering pipeline from Section 10.6] |
| Primary Language | [Language] |
| IDE / Editor | [e.g. JetBrains Rider, Visual Studio, VS Code] |
| Version Control | [e.g. Git + GitHub / Plastic SCM] |
| Art Pipeline | [e.g. Blender → Unity / Maya → Unreal — must match technical form from Section 2.1] |
| Audio Middleware | [e.g. FMOD, Wwise, built-in engine audio] |
| CI / Build | [e.g. GitHub Actions, Jenkins, Unity Cloud Build] |
| Project Management | [e.g. Jira, Linear, Notion, Shortcut] |

### 12.2 PC Requirements

| Spec | Minimum | Recommended |
|------|---------|-------------|
| OS | [e.g. Windows 10 64-bit] | [e.g. Windows 11 64-bit] |
| CPU | [e.g. Intel Core i5-8400 / AMD Ryzen 5 2600] | [e.g. Intel Core i7-10700K / AMD Ryzen 7 5800X] |
| RAM | [e.g. 8 GB] | [e.g. 16 GB] |
| GPU | [e.g. NVIDIA GTX 1060 6GB / AMD RX 580] | [e.g. NVIDIA RTX 3070 / AMD RX 6800 XT] |
| Storage | [e.g. 20 GB HDD] | [e.g. 20 GB NVMe SSD] |
| DirectX | [e.g. DirectX 11] | [e.g. DirectX 12] |

### 12.3 Custom Systems to Develop

| System | Purpose | Complexity | Priority |
|--------|---------|------------|----------|
| [System name — tied to a specific mechanic from Section 5] | [What it does and why off-the-shelf solutions are insufficient] | [Low / Mid / High] | [P0 — launch blocker / P1 — important / P2 — nice to have] |
| [System] | [purpose] | [complexity] | [priority] |
| [System] | [purpose] | [complexity] | [priority] |

### 12.4 Networking Requirements
[If the player mode from Section 2.1 includes online features: describe server architecture (dedicated / peer-to-peer / hybrid), matchmaking approach, save synchronization, and anti-cheat considerations. If offline-only: state this explicitly and note any cloud save or leaderboard features.]
