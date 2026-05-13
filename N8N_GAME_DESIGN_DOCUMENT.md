# GAME DESIGN DOCUMENT

**Title:** Sting Protocol  
**Tagline:** One shot. One sting. One chance to hit the impostor.  
**GDD Version:** 1.0  
**Date:** 2026  
**Genre:** Third-person stealth action / social-deduction shooter  
**Platform:** PC (Steam)

---

## 1. OVERVIEW

### 1.1 Concept
*Sting Protocol* is a third-person stealth action prototype in which the player controls a lone special-ops worker bee infiltrating a neon-drenched underground bunker overrun by shapeshifting aliens disguised as human staff. The player must observe behavior, use cover, and deliver precise venom shots to expose and eliminate impostors before suspicion escalates and the hive mission collapses. Every shot matters: venom is limited, targets are mixed among real humans, and a single correct sting can trigger a dazzling allergic bloom that turns the alien into explosive confetti. The excitement comes from the tension between stealth patience and split-second precision under pressure.

### 1.2 Design Pillars

| Pillar | Description |
|--------|-------------|
| Precision Over Volume | Combat is built around deliberate single-shot decisions, not sustained firefights. Players should feel the weight of every sting. |
| Read the Room | Success depends on observation, pattern recognition, and identifying subtle tells in crowds rather than simply reacting to red-highlighted enemies. |
| Stylish Covert Chaos | The mood blends slick stealth tension with absurd, high-saturation alien explosions, creating memorable visual payoffs after careful setup. |

### 1.3 Target Audience
Primary audience is players aged 16–35 who enjoy stealth, immersive decision-making, and short replayable challenge runs. They regularly play games such as *Hitman: World of Assassination*, *Gunpoint*, *Intravenous*, *Party Hard*, *The Swindle*, and *Ape Out*, and they are motivated by mastery, efficiency, and the thrill of solving tense scenarios cleanly. Secondary audience includes indie action fans attracted by a strong visual hook, readable systems, and high shareability through surprising impostor reveals and stylish explosions. Because the project is a prototype, the target player also values compact experiences that can be finished in under 2 hours but replayed for better ratings.

### 1.4 Competitive Landscape

| Comparable Game | What We Do Differently |
|----------------|------------------------|
| Hitman: World of Assassination | Replaces broad sandbox assassination with tight, real-time social deduction centered on identifying non-obvious impostors from within mixed civilian groups. |
| Intravenous | Uses stealth and lethal precision, but swaps conventional gunplay for a single-ammo venom system built around exposure, not suppression. |
| Among Us | Adapts impostor identification into a solo, real-time infiltration shooter with behavioral tells and immediate lethal consequences instead of voting. |

### 1.5 Unique Selling Point
*Sting Protocol* delivers the fantasy of being a tiny covert assassin in a hostile human environment where every kill is also a deduction test. It stands out by combining third-person stealth movement with one-shot venom precision against shapeshifting targets hidden in plain sight.

---

## 2. GENRE, PLATFORM & TECHNICAL FORM

### 2.1 Classification

| Field | Value |
|-------|-------|
| Primary Genre | Stealth Action |
| Subgenres | Social-deduction shooter, tactical infiltration, score-attack prototype |
| Player Mode | Single-player |
| Camera / Perspective | Third-person over-the-shoulder |
| Art Style | Stylized 3D with neon-noir lighting and readable low-scope character design |
| Technical Form | 3D real-time |

### 2.2 Platforms & Devices

| Platform | Priority | Notes |
|----------|----------|-------|
| PC (Steam) | Primary | Keyboard/mouse precision aiming is ideal for the venom-shot core loop; prototype launch target |
| Steam Deck | Secondary | Requires UI scaling, controller support, and capped performance mode at 40 fps |

### 2.3 Estimated Playtime
- **Main story:** 1.5 hours
- **Side content:** 1 additional hour
- **Completionist:** 4 total hours
- **Average session length:** 20 minutes

---

## 3. GAMEPLAY

### 3.1 Feel Statement
Playing *Sting Protocol* should feel like sneaking a razor blade through velvet. The player glides low through metallic corridors, pauses behind lab equipment, studies body language in fluorescent silence, then commits to a single lethal sting with surgical certainty. Tension rises from not knowing who is real and who is wearing a human shape badly. When the shot lands correctly, the game releases pressure in a burst of color, sound, and motion.

### 3.2 Key Player Activities

1. **Shadow and Observe** — The player trails patrols and civilian groups to identify suspicious movement patterns, creating satisfaction through deduction rather than brute force.
2. **Take Precision Venom Shots** — The player lines up exact sting angles from cover, and the reward is a high-stakes one-hit reveal or kill.
3. **Reposition Through Micro-Cover** — The player moves between desks, pipes, vents, and machinery, using the bee’s small size to create stealth paths humans cannot.
4. **Manage Suspicion Cascades** — The player reacts to rising bunker alert states, cleans up after mistakes, and decides whether to risk another shot or disappear.

### 3.3 Key Features (Marketable)

- **Real-Time Social Deduction:** Aliens blend into human staff, forcing players to identify behavioral tells before firing.
- **One-Sting Combat:** Venom ammo is scarce and deadly, making each shot a consequential tactical choice.
- **Micro-Scale Infiltration:** Players navigate a human bunker from a bee’s perspective, transforming mundane props into stealth architecture.
- **Explosive Allergic Blooms:** Correct hits on disguised aliens trigger vivid confetti-like detonations that provide both spectacle and tactical disruption.
- **Replayable Score Runs:** Fast missions, rankings, optional challenge modifiers, and alternate routes support mastery and streaming appeal.

### 3.4 Player Journey

1. **Insertion** — The player learns movement, cover, and the difference between human traffic and alien tells in a low-alert maintenance wing.
2. **Suspicion** — More mixed groups appear, cameras and security staff complicate movement, and the player learns that wrongful stings carry serious penalties.
3. **Deep Cover** — Mid-game introduces cluster encounters, bait behaviors, and elite shapeshifters who mimic humans more convincingly.
4. **Containment Breach** — Alert systems intensify, rooms lock down dynamically, and the player must use environmental paths and chain reactions to stay ahead.
5. **Hive Verdict** — The player reaches the core command chamber, identifies the alien coordinator inside a crowd, and resolves the mission through one final precision kill.

### 3.5 Win, Lose & Difficulty

| Condition | Description |
|-----------|-------------|
| **Win Condition** | Complete all bunker sectors and eliminate the alien coordinator, then extract through the rooftop ventilation shaft. |
| **Lose Condition** | The player fails if health reaches 0, global suspicion reaches 100%, or 3 civilians are wrongly stung in a mission. |
| **Difficulty Scaling** | On Normal, later rooms increase patrol density, reduce safe observation windows, and introduce advanced mimics with fewer obvious tells. |
| **Fail State Recovery** | On failure, the player restarts from the last sector checkpoint, retaining unlocked codex intel and completed challenge milestones but losing current mission score. |

---

## 4. CORE LOOP

### 4.1 Loop Name
**Observe → Confirm → Sting → Reposition**

### 4.2 Loop Steps

| Step | Player Action | Immediate Feedback | Reward |
|------|--------------|-------------------|--------|
| 1 | Scout a room from cover and track NPC behavior | Visual tells, suspicion icons, patrol patterns become readable | Information and route options |
| 2 | Mark a probable alien and line up a venom shot | Aim assist tightens, heartbeat audio rises, target animation exposes subtle tells | Decision tension and shot opportunity |
| 3 | Fire a venom sting at the chosen target | Human target triggers alarm penalty; alien target erupts in Allergic Bloom confetti explosion | Threat removal, score, intel, temporary area disruption |
| 4 | Relocate before witnesses or security converge | Cover indicators, alert cones, and vent routes open or close based on noise | Survival, better angle, continued infiltration |

### 4.3 Loop Metrics
- **Average loop duration:** 2.5 minutes
- **Retention hook:** The need to test “just one more room” and prove a cleaner, smarter identification chain than the previous run
- **Variable reward moment:** The instant after a sting lands, when the player discovers whether the target was human or alien

---

## 5. GAME MECHANICS

### 5.1 Aim-and-Sting

**Category:** Combat  
**Description:** The player fires a single venom dart from the bee’s abdomen stinger while aiming in over-the-shoulder view. Shots are highly accurate when stationary or anchored to cover, but wing drift and stress bloom reduce precision while moving. If the target is an alien, venom triggers a delayed allergic cascade and explosive transformation.  
**Player Goal:** Correctly identify and eliminate disguised aliens with the fewest possible shots.  
**Rules:** The player carries 6 venom charges per sector. Base shot travel is hitscan to 18 meters. Firing while moving adds 22% spread; firing from cover reduces spread to 4%. Alien targets detonate after a 0.6 second reaction delay in a 2.5 meter blast radius. Human targets survive but enter panic, instantly adding 35% suspicion.  
**Depth:** Novices use venom as a test shot at obvious suspects. Experts learn to read animation tells, shoot from safe angles, and trigger Allergic Bloom explosions that distract guards or expose nearby mimics.  
**Integration:** Aim-and-Sting is the centerpiece that connects to Cover Skitter for setup, Suspicion Web for consequences, and Pheromone Pulse for target confirmation.

---

### 5.2 Cover Skitter

**Category:** Movement / Stealth  
**Description:** The bee automatically snaps to valid cover edges such as desks, pipes, lockers, mugs, and toolboxes. While in cover, the player can sidle, peek, fast-hop to nearby cover nodes, or launch into a short dash flight across exposed gaps.  
**Player Goal:** Stay unseen while moving into optimal observation and firing positions.  
**Rules:** Cover transitions within 3 meters are instant. Dash flight covers up to 5 meters and has a 2 second recovery before another dash. Entering cover reduces detection gain by 70%. Crossing a light beam or direct human line of sight while airborne adds detection immediately.  
**Depth:** Novices use cover defensively. Experts chain micro-cover transitions, exploit the bee’s scale to route through clutter, and use airborne dashes only during NPC look-away windows.  
**Integration:** Cover Skitter supports Aim-and-Sting by stabilizing shots, interacts with Suspicion Web by managing exposure, and enables access to hidden vents that contain Nectar pickups and intel.

---

### 5.3 Pheromone Pulse

**Category:** Detection / Utility  
**Description:** The bee emits a short-range pheromone scan that highlights behavioral anomalies in nearby targets. The pulse does not reveal a full answer, but it amplifies subtle signs such as delayed mimic reactions, incorrect pathing, or unstable body outlines.  
**Player Goal:** Narrow down suspects before committing a venom shot.  
**Rules:** Pulse radius is 8 meters. Cooldown is 12 seconds. Pulse marks suspicious NPCs with one to three hex pips for 6 seconds; three pips indicate high mimic probability, but not certainty. Elite mimics can suppress one pip when not under stress. Pulse cannot penetrate thick walls but passes through glass.  
**Depth:** Novices use the pulse as a crutch. Experts save it for dense crowds, combine it with observation, and understand that high suspicion markers still require confirmation.  
**Integration:** Pheromone Pulse feeds directly into Aim-and-Sting decisions, lowers wrongful stings, and complements narrative codex entries that teach specific alien behaviors.

---

### 5.4 Suspicion Web

**Category:** AI / Alert / Economy  
**Description:** Suspicion Web is the mission-wide alert system representing how close bunker inhabitants are to exposing the bee and recognizing the alien threat. It rises from bad shots, visible movement, discovered explosions, and prolonged presence in watched areas, but can be managed through stealthy eliminations and misdirection.  
**Player Goal:** Keep suspicion below critical levels long enough to complete objectives and escape.  
**Rules:** Suspicion ranges from 0 to 100. At 25, guards investigate unusual sounds. At 50, cameras rotate faster and patrol routes widen. At 75, sector lockdowns begin and elite responders deploy. At 100, mission failure triggers. Correct alien eliminations seen by humans add only 10 suspicion due to confusion; wrongful stings add 35; being directly spotted adds 20 per second.  
**Depth:** Novices treat suspicion as passive punishment. Experts intentionally spike and bleed it, using Allergic Bloom chaos to shift patrols and open paths.  
**Integration:** Suspicion Web links all mechanics together, defining the risk profile of movement, targeting, and utility use while pacing mission escalation.

---

## 6. PROGRESSION SYSTEM

### 6.1 System Overview
**System name:** Hive Clearance Track  
**Description:** Progression in *Sting Protocol* is compact and prototype-friendly, focused on unlocking tactical breadth rather than large RPG stat inflation. Players improve through mission completion, score thresholds, and recovered bunker intel, gaining new abilities and passive upgrades that encourage cleaner infiltrations and more confident target identification.

### 6.2 Game Phases

| Phase | Time Range | Power Level | Content Available | Key Unlock |
|-------|------------|-------------|------------------|------------|
| Probation Flight | 0–0.5 hrs | Low / Building | Movement basics, first sector, standard mimics | Pheromone Pulse |
| Deep Infiltration | 0.5–1.2 hrs | Mid | Security systems, side rooms, elite mimics, score challenges | Venom Reclaim |
| Hive Ace | 1.2+ hrs | High / Mastery | Final sector, full challenge modifiers, all mission ratings | Royal Mark |

### 6.3 Player Stats & Attributes

| Stat | Description | Base Value | Max Value | How It Grows |
|------|-------------|------------|-----------|--------------|
| Vitality | Determines total health before mission failure | 3 HP | 5 HP | Upgrade nodes and hidden brood caches |
| Wing Stability | Reduces aim sway and airborne spread | 50 | 100 | Intel unlocks and score milestones |
| Venom Capacity | Determines how many sting charges the player carries per sector | 6 | 9 | Equipment unlocks from mission ratings |
| Pheromone Efficiency | Improves pulse duration and elite mimic readability | 100% | 160% | Hive Clearance upgrades |

### 6.4 Player Abilities & Actions

| Ability | Unlock Condition | Description | Cooldown / Cost |
|---------|-----------------|-------------|-----------------|
| Venom Sting | From start | Fires one lethal venom shot that exposes or destroys alien targets | Costs 1 venom charge |
| Cover Dash | From start | Quick burst between cover nodes or across exposed gaps | 2 second cooldown |
| Pheromone Pulse | Unlocked after first sector tutorial room | Emits a scan that marks suspicious NPCs with mimic probability pips | 12 second cooldown |
| Venom Reclaim | Unlocked at 4,000 total score | Recover 1 spent venom charge from a fresh alien bloom residue | 20 second cooldown, only near alien remains |
| Royal Mark | Unlocked after beating the prototype once | Manually tag one target for 10 seconds, increasing Pulse accuracy and score multiplier if correctly stung | 30 second cooldown |

### 6.5 Unlockables & Rewards

| Category | Examples | How Earned |
|----------|----------|------------|
| Equipment | Stabilized Stinger, Quiet Thorax Plating, Nectar Capsule | Earned through mission ratings and score thresholds |
| Cosmetics | Amber Wing trail, Hive Gold shell tint, Neon hazard stripe pattern | Earned by challenge completion and hidden collectible sets |
| Codex Intel | Mimic anatomy file, Bunker staff roster, Sector incident logs | Found in side rooms and rewarded for perfect identifications |
| Modifiers | Iron Venom, No Pulse Run, Speed Hive | Unlocked after first full completion |

---

## 7. NARRATIVE & WORLD

### 7.1 Logline
A genetically enhanced worker bee operative must identify and eliminate shapeshifting aliens hidden inside a buried defense bunker before the impostors trigger a surface-wide replacement event.

### 7.2 Setting
The game takes place in Blackvault-9, a subterranean military research bunker built beneath a rain-soaked megacity in the late 2080s. From a bee’s scale, the facility feels enormous: fluorescent hallways become canyons, coffee spills become reflective hazards, and machinery hums like thunder. Humans believe the bunker is managing a biosecurity lockdown, but in truth an alien infiltrator species has begun replacing key personnel. The world is visually defined by neon emergency strips, glossy industrial surfaces, vapor haze, and bright organic eruptions when alien disguises fail.

### 7.3 Lore & History
Twenty years before the game, a meteor fragment recovered from the Arctic exposed humanity to the Veskar, a parasitic mimic species capable of imitating mammalian bodies after brief contact. Blackvault-9 was founded to study containment methods, but the project’s director secretly weaponized mimic tissue for infiltration research. The Veskar adapted faster than expected, infiltrating the bunker’s staff hierarchy and sabotaging external communications under the cover of a quarantine drill. In response, the clandestine Apis Division bred miniature bio-operatives from hive stock, creating intelligent worker bees able to carry tailored venom that destabilizes mimic proteins. Over the course of the game, the player discovers that the outbreak is not accidental; a human collaborator intended to trade surface access for power.

### 7.4 Main Story Arc

**Act 1 — Smoke in the Vent**
Agent Mell launches into Blackvault-9 through a damaged ventilation shaft after Apis Division loses contact with its internal informants. The first objective is to verify mimic presence, navigate maintenance corridors, and recover the identity key of a missing scientist.

**Act 2 — Faces That Slip**
Mell pushes deeper into labs and command sectors, discovering that the Veskar have replaced both security officers and civilian staff. A mid-point revelation exposes Director Halden Voss as the human collaborator who opened secure zones in exchange for promised survival during the replacement event.

**Act 3 — The Queen’s Debt**
In the command rotunda, Mell confronts Voss and the Veskar coordinator embedded among surviving staff. The player must identify the true coordinator under intense alert pressure, eliminate it with a final Royal Mark-assisted sting, and transmit the purge code before escaping to the surface vent line.

### 7.5 Themes

| Theme | How It Manifests in the Game |
|-------|------------------------------|
| Trust Under Pressure | The player is constantly forced to judge who is real with incomplete information, echoing the narrative’s paranoia. |
| Scale and Power | Though tiny and fragile, the bee can dismantle a bunker-wide conspiracy through precision rather than brute force. |
| Identity as Performance | The Veskar mimic human behavior imperfectly, and gameplay revolves around noticing where imitation breaks down. |

### 7.6 Factions & Groups

| Name | Alignment | Goals | Player Relationship |
|------|-----------|-------|---------------------|
| Apis Division | Allied | Contain the Veskar outbreak and preserve surface humanity | Provides mission voice-over, upgrades, and extraction support |
| Veskar Brood | Enemy | Replace key bunker staff and open a route to the surface | Primary targets; encountered disguised as humans |
| Blackvault Security Corps | Neutral / Enemy under alert | Maintain lockdown and suppress perceived intruders | Avoided, manipulated, or accidentally turned hostile through suspicion |

### 7.7 Environments & Levels

| Environment | Visual Feel | Gameplay Role | Narrative Significance |
|-------------|-------------|---------------|------------------------|
| Service Duct Delta | Tight steel vents, blinking red maintenance lights, condensation drips | Tutorial movement space teaching Cover Skitter, peeking, and target observation | Establishes bee-scale perspective and covert insertion tone |
| Bio Lab Helix | Cyan light, glass tanks, spilled chemicals, polished white floors | Introduces mixed civilian groups, glass line-of-sight, and first elite mimic behaviors | Reveals the origin of anti-mimic venom research |
| Mess Hall Aurora | Magenta signage, vending machines, crowded tables, holographic menus | Dense social-deduction arena with the highest risk of wrongful stings | Demonstrates how deeply the mimics have embedded among daily staff life |
| Command Rotunda | Vast circular chamber, gold emergency strobes, central hologram pillar | Final multi-target identification encounter under rising lockdown pressure | Site of Voss’s betrayal and the coordinator’s last stand |

### 7.8 Narrative Delivery
Story is delivered through short in-engine cutscenes, radio dialogue from Apis handler Nyra Vale, overheard human conversations, environmental storytelling, and collectible codex logs. The balance favors light-touch narrative delivery during active play, keeping momentum on stealth and deduction. Cutscenes are brief and used mainly for mission transitions, the reveal of Voss, and the ending. Most lore is optional but reinforces target-reading by explaining mimic biology and bunker routines.

---

## 8. CHARACTERS

### 8.1 Mell-7 “Mell” — Protagonist

| Field | Detail |
|-------|--------|
| Role | Protagonist |
| Age | 2 months biological age; equivalent cognition of a trained adult operative |
| Appearance | Small amber-and-onyx worker bee with reinforced thorax plating, luminous blue visor lenses, clipped reconnaissance wings, and a modular stinger harness mounted beneath the abdomen |
| Personality | Focused, dryly witty, observant, disciplined, and quietly compassionate. Mell speaks in brief tactical lines and handles conflict through analysis before action. |
| Backstory | Mell-7 was bred in Apis Division’s covert hive program as part scout, part assassin, and part forensic observer. Unlike earlier bio-operatives, Mell demonstrated unusual pattern recognition and empathy toward non-combatants, making them ideal for infiltration where innocent lives are mixed with targets. |
| Motivation | Mell wants to stop the Veskar outbreak and prove that worker-class operatives are more than disposable tools. Mell fears failing the mission through one wrong sting and causing innocent deaths. |
| Character Arc | Mell begins as a precise but emotionally detached instrument of the hive and ends by acting on personal judgment, choosing to save survivors instead of only completing the kill order. |
| Gameplay Abilities | Venom Sting, Cover Dash, Pheromone Pulse |

---

### 8.2 Nyra Vale — Mission Handler

| Field | Detail |
|-------|--------|
| Role | Mentor |
| Age | 38 |
| Appearance | Lean woman with silver undercut hair, dark tactical coat, amber AR contact lenses, and a throat implant used for secure hive-channel communication |
| Personality | Calm, incisive, sardonic, and deeply protective of her agents. She speaks with clipped authority but lets warmth show in private moments. |
| Backstory | Nyra was once Blackvault-9’s lead xenobiologist before she exposed internal ethics violations and was recruited into Apis Division. She helped engineer the venom strain Mell uses and knows the bunker better than any surviving ally. |
| Motivation | She wants to contain the outbreak and atone for helping create the systems that made mimic infiltration possible. |
| Character Arc | Nyra starts as a remote commander prioritizing mission efficiency but gradually reveals guilt and a personal stake in saving trapped staff. |
| Gameplay Role | Provides live tactical intel, unlock tutorials organically, and grants progression upgrades between sectors. |

---

### 8.3 Director Halden Voss — Antagonist

| Field | Detail |
|-------|--------|
| Role | Antagonist |
| Age | 54 |
| Appearance | Tall, immaculate, pale-skinned executive in a white bunker command suit with gold collar trim, cybernetic left eye, and permanently composed posture |
| Personality | Charismatic, vain, manipulative, and coldly rational. He speaks like every betrayal is simply the smartest option available. |
| Backstory | As director of Blackvault-9, Voss oversaw mimic research and containment infrastructure. When he realized the Veskar could not be fully controlled, he negotiated with them, believing collaboration would preserve his status in the new order. |
| Motivation | Voss wants to survive the replacement event and retain authority by delivering the bunker to the Veskar intact. |
| Character Arc | Voss represents surrender disguised as pragmatism; by the end he loses control of both the bunker and the species he tried to bargain with. |
| Gameplay Role | Serves as narrative pressure through voice broadcasts, triggers sector lockdowns, and appears in the final encounter as a shield around the coordinator. |

---

## 9. USER INTERFACE & UX

### 9.1 UI Philosophy
UI should be minimal during observation and highly legible during commitment moments. The player must read the world first, with HUD elements only surfacing the information needed to support precision, suspicion management, and stealth routing.

### 9.2 HUD Elements

| Element | Position | Information Displayed | Visibility |
|---------|----------|-----------------------|------------|
| Health Pips | Top-left | Current Vitality in 3–5 segmented pips | Always |
| Venom Counter | Bottom-right | Remaining venom charges and reclaim readiness | Always |
| Suspicion Meter | Top-center | Global Suspicion Web value from 0–100 with threshold markers | Always |
| Target Readout | Center near reticle | Pheromone Pulse pips, range, and Royal Mark status on aimed target | Contextual |

### 9.3 Menu Structure

```text
MAIN MENU
├── New Game
├── Continue
├── Mission Select
├── Settings
│   ├── Video
│   ├── Audio
│   ├── Controls
│   └── Accessibility
└── Quit

IN-GAME PAUSE MENU
├── Resume
├── Map / Journal / Intel
├── Settings
├── Save Game
└── Return to Main Menu
```

### 9.4 Controls

**Keyboard & Mouse**

| Input | Action |
|-------|--------|
| W / A / S / D | Move |
| Mouse | Camera / Aim |
| Left Mouse Button | Fire Venom Sting |
| Right Mouse Button | Aim / Tighten reticle |
| Space | Cover Dash / Context movement |
| Q | Pheromone Pulse |

**Controller (Xbox layout)**

| Input | Action |
|-------|--------|
| Left Stick | Move |
| Right Stick | Camera / Aim |
| RT | Fire Venom Sting |
| LT | Aim / Tighten reticle |
| A | Cover Dash / Context movement |

### 9.5 Onboarding & Tutorial
The first 15 minutes take place in Service Duct Delta and the adjoining maintenance office. The player learns movement through a collapsing vent path, cover by crossing exposed sightlines beneath a janitor’s cart, and venom use by identifying an obviously unstable mimic mimicking a wounded technician. Nyra gives short voice prompts only after player hesitation, keeping instruction reactive rather than intrusive. The first genuine moment of player agency comes in the maintenance office, where three staff members move through intersecting routes and the player can choose when and from where to verify the alien target.

### 9.6 Accessibility Features
- Fully remappable keyboard and controller inputs
- Subtitles with speaker identification, background opacity, and 3 size options
- Colorblind modes: Protanopia, Deuteranopia, Tritanopia
- Aim assistance options with adjustable reticle magnetism and slowdown
- Reduced flash / explosion intensity mode for Allergic Bloom effects

---

## 10. ART DIRECTION & AUDIO

### 10.1 Visual Identity
*Sting Protocol* uses a stylized neon-noir 3D aesthetic designed for a small prototype team: bold lighting, clean silhouettes, selective texture detail, and strong contrast between sterile human spaces and unstable alien reveals. At a glance, the game should read as “tiny covert agent in a giant dangerous world.” Metallic surfaces, holographic signage, and colored fog create mood, while alien deaths erupt into saturated pollen-like confetti to punctuate tension with visual payoff. The emotional tone is slick, tense, strange, and slightly darkly comic.

### 10.2 Art Style References

| Reference | What We Take From It |
|-----------|----------------------|
| Control | Brutalist interior scale, dramatic lighting, and supernatural disruption inside institutional spaces |
| Sifu | Clean, readable combat framing and bold color separation in compact environments |
| Spider-Man: Into the Spider-Verse | Stylized color confidence and graphic pop for impact moments without photoreal production burden |

### 10.3 Color Palette

| Role | Color Description | Tone | Usage |
|------|------------------|------|-------|
| Primary | Deep graphite blue | Dark | Environments, shadowed metal, UI base |
| Secondary | Cold cyan glow | Mid / Light | Labs, holograms, glass reflections, stealth highlights |
| Accent | Electric magenta | Bright | Signage, elite mimic cues, bloom effects |
| Danger / Alert | Acid amber-red | Bright | Suspicion meter, alarms, lockdown lighting |

### 10.4 Character Visual Style
Characters use stylized realistic proportions with simplified materials and strong silhouettes for readability at distance. Human staff silhouettes are intentionally consistent by role, while Veskar disguises include subtle animation offsets and brief outline distortions visible on close inspection or during Pheromone Pulse. Mell is rendered with exaggerated wing shimmer, a clear visor face area, and a distinctive stinger harness to maintain identity despite small screen presence.

### 10.5 Environment Visual Style
Environments are compact but dense with oversized everyday objects to sell the bee-scale fantasy. Lighting relies on emissive signage, practical fluorescents, emergency strobes, and controlled volumetric fog to produce depth without requiring huge geometry counts. Textures are medium density with strong roughness variation rather than ultra-high detail. Scale is emphasized through long sightlines, echoing machinery, and clutter-based traversal routes.

### 10.6 Technical Visual Targets
- **Target resolution:** 1080p native, up to 1440p on capable hardware
- **Frame rate target:** 60 fps locked, 40 fps Steam Deck target
- **Rendering pipeline:** Unity URP
- **Key visual effects:** wing shimmer trails, venom impact spark, Allergic Bloom confetti explosion, holographic UI flicker, lockdown strobe haze

### 10.7 Music & Sound Design

| Element | Description |
|---------|-------------|
| Music Genre | Tense electronic noir with stealth pulses and synthetic bass |
| Instrumentation | Analog synths, processed hive hums, muted percussion, granular textures |
| Adaptive Music | Layers intensify as Suspicion Web rises, with precision-hit stingers on successful alien eliminations |
| Sound Design Style | Stylized hybrid; tiny bee movement is crisp and tactile, while bunker machinery and alien distortion are heavy and unsettling |
| Voice Over | Partial VO with strong mission dialogue, short antagonist broadcasts, and minimal protagonist lines |
| Ambience | Vent echoes, fluorescent buzz, distant intercom chatter, and low biological warble near hidden mimics create paranoia |

### 10.8 Magic Moments
1. **First Bloom** — The player’s first correct sting causes a disguised technician to burst into neon pollen confetti under sterile lab lights, confirming the threat in a shocking visual release.
2. **Cafeteria Misread** — In Mess Hall Aurora, dozens of civilians move through overlapping routes while one mimic subtly mirrors the wrong social cues, creating a tense “everyone could be the target” set piece.
3. **Rotunda Reveal** — During the finale, the hologram pillar collapses into warning light as the true Veskar coordinator flickers through multiple stolen faces before the final shot lands.

---

## 11. GAME ECONOMY & REWARDS

### 11.1 Monetization Model
**Model:** Premium  
**Price point:** $9.99 on PC  
**Description:** *Sting Protocol* is a compact premium prototype experience with no microtransactions and no premium currency. The price fits the game’s short playtime, replayable score-driven structure, and indie stealth audience expectations. If reception is strong, future monetization would come from a larger standalone expansion or sequel rather than live-service additions.

### 11.2 Currencies

| Currency | Type | How Earned | How Spent | Purchasable? |
|----------|------|------------|-----------|--------------|
| Nectar | Soft | Completing sectors, hidden pickups, clean stealth bonuses, challenge objectives | Unlocking upgrades, equipment modules, and cosmetic tints | No |
| Intel Fragments | Soft | Scanning logs, perfect alien identification streaks, secret room discoveries | Unlocking codex entries, mimic behavior hints, and advanced challenge modifiers | No |

### 11.3 Reward Structure

| Reward Type | Trigger | Frequency | Emotion Targeted |
|-------------|---------|-----------|-----------------|
| Score Gain | Correct alien elimination, stealth movement, clean sector completion | Constant | Momentum, mastery |
| Nectar Pickup | Side path exploration and encounter completion | Frequent | Satisfaction, route curiosity |
| Upgrade Unlock | Reaching mission rank thresholds | Moderate | Growth, capability |
| Intel Discovery | Finding logs or achieving perfect ID chains | Intermittent | Curiosity, competence |

### 11.4 Economy Balance Notes
- Nectar rewards are front-loaded enough that players can unlock one meaningful upgrade after their first full run.
- Intel Fragments are separated from Nectar to prevent pure grinding from replacing actual observation and exploration.
- Cosmetic unlock costs remain low so replaying for style rewards feels additive, not punitive.

---

## 12. TECHNICAL SPECIFICATIONS

### 12.1 Engine & Tools

| Category | Tool / Technology |
|----------|------------------|
| Game Engine | Unity 6 (URP) |
| Primary Language | C# |
| IDE / Editor | JetBrains Rider |
| Version Control | Git + GitHub |
| Art Pipeline | Blender → Unity |
| Audio Middleware | FMOD |
| CI / Build | GitHub Actions |
| Project Management | Notion + Jira |

### 12.2 PC Requirements

| Spec | Minimum | Recommended |
|------|---------|-------------|
| OS | Windows 10 64-bit | Windows 11 64-bit |
| CPU | Intel Core i5-8400 / AMD Ryzen 5 2600 | Intel Core i7-10700 / AMD Ryzen 7 3700X |
| RAM | 8 GB | 16 GB |
| GPU | NVIDIA GTX 1060 6 GB / AMD RX 580 | NVIDIA RTX 3060 / AMD RX 6700 XT |
| Storage | 8 GB SSD | 8 GB NVMe SSD |
| DirectX | DirectX 11 | DirectX 12 |

### 12.3 Custom Systems to Develop

| System | Purpose | Complexity | Priority |
|--------|---------|------------|----------|
| Mimic Behavior Profiling System | Drives subtle NPC tell generation so aliens can be deduced from animation, routing, and reactions rather than simple shaders | High | P0 |
| Suspicion Web Director | Manages mission-wide alert escalation, witness propagation, lockdown thresholds, and response behaviors | Mid | P0 |
| Micro-Cover Navigation Grid | Supports bee-scale snapping to nonstandard cover objects and context-sensitive dash movement through clutter | Mid | P1 |

### 12.4 Networking Requirements
The prototype is offline-only. There is no matchmaking, no online persistence, and no server architecture requirement. Steam Cloud save sync is supported for settings, unlocks, and mission ratings. No anti-cheat solution is required for the prototype build.

---

## 13. PRODUCTION PLAN

### 13.1 Team Composition

| Role | Headcount | Notes |
|------|-----------|-------|
| Game Designer(s) | 1 | Systems, stealth tuning, mission design |
| Programmer(s) | 2 | Gameplay, AI, UI, tools |
| Artist(s) | 2 | 1 environment/props generalist, 1 character/VFX generalist |
| Animator(s) | 1 | Character animation, mimic tells, camera polish |
| Narrative Designer / Writer | 1 | Part-time, supports VO and codex writing |
| Audio Designer | 1 | Contracted part-time for music implementation and SFX |
| QA | 1 | Outsourced part-time during late alpha and beta |
| Producer | 1 | Scope management, milestone tracking, external coordination |
| **Total** | **9** | |

### 13.2 Development Timeline

**Total estimated duration:** 9 months

| Phase | Duration | Goals |
|-------|----------|-------|
| **Pre-Production** | 2 months | Prototype core loop, lock design pillars, hire core team, produce vertical slice |
| **Production — Alpha** | 3 months | All core mechanics implemented, first 3 levels complete, placeholder art pass done |
| **Production — Beta** | 2 months | Content complete, all systems integrated, performance optimized, external QA begins |
| **Gold / Submission** | 3 weeks | Bug fixes only, platform certification, localization final, marketing assets ready |
| **Post-Launch** | 2 months | Patches, community feedback integration, DLC development if applicable |

### 13.3 Key Milestones

| Milestone | Target Phase | Success Criteria |
|-----------|-------------|------------------|
| Playable prototype | End of Pre-Production | Core loop is fun for 15 minutes |
| Vertical slice | 2 months in | One polished level representing the full quality bar |
| Alpha build | 5 months in | Game is playable start to finish without crashes |
| Beta build | 7 months in | Feature complete, passes external playtest |
| Gold master | 3 weeks before launch | Passes platform certification |
| Launch | Fall 2026 | Ships on all target platforms simultaneously |

### 13.4 Risk Assessment

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Social-deduction reads are too vague, causing frustration instead of satisfying inference | Mid | High | Build the Mimic Behavior Profiling System first, run weekly playtests, and require at least 3 readable tells per encounter type |
| Bee-scale camera and cover movement feel awkward in 3D spaces | Mid | High | Prototype camera distance, FOV, and snap logic in greybox during week 2; cut any traversal feature that compromises readability |
| Scope creep from adding more sectors, enemy types, or story scenes | High | High | Lock the prototype to 4 environments, 3 major character roles, and 5 abilities; all additions require producer approval and must replace existing scope |
| Performance issues from heavy VFX and neon lighting in Unity URP | Mid | Mid | Use stylized low-overdraw effects, profile every milestone on minimum spec hardware, and cap particle counts for Allergic Bloom events |
| AI witness logic creates inconsistent Suspicion Web spikes | Mid | Mid | Centralize suspicion calculations in one director system and build automated test scenes for witness propagation and alert thresholds |

### 13.5 Review & Iteration Process
The team conducts internal playtests twice per week during pre-production and weekly thereafter, with each session focused on one pillar: precision, deduction, or stylish payoff. Design review happens every Friday with the designer, producer, lead programmer, and art lead, using recorded play sessions and a short issue severity rubric. The creative director function is held by the lead game designer, who has final authority on mechanic changes, while the producer has final authority on scope and schedule tradeoffs. External playtests begin in beta with 12–20 players drawn from stealth game communities, and feedback is categorized into readability, frustration, and replayability.

---

## APPENDIX A — GLOSSARY

| Term | Definition |
|------|------------|
| Allergic Bloom | The explosive reaction that occurs when venom destabilizes a disguised Veskar alien |
| Suspicion Web | The global alert meter tracking how close the bunker is to exposing the player and escalating lockdown |
| Royal Mark | A late-game targeting ability that temporarily tags a suspect to improve confirmation and scoring |

---

## APPENDIX B — OPEN QUESTIONS

| # | Question | Owner | Target Resolution Phase |
|---|----------|-------|------------------------|
| 1 | Should human NPCs have one emergency evacuation behavior to reduce crowd unpredictability after an Allergic Bloom? | Designer | Alpha |
| 2 | Is Steam Deck performance acceptable at 40 fps with current VFX density? | Technical Director | Beta |
| 3 | Should the final command rotunda allow multiple valid coordinator-identification strategies or require one authored solution? | Creative Director | Pre-Production |

---

## APPENDIX C — REVISION HISTORY

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-05-12 | OpenAI | Initial GDD generated from prompt |