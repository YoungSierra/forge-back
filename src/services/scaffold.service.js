// Scaffold de estructura de proyecto por engine — carpetas, root files y mapeo de assets

// ─── Carpetas por engine ──────────────────────────────────────────────────────

const FOLDERS = {
  unity: [
    'Assets/Art/2D/Sprites',
    'Assets/Art/2D/UI',
    'Assets/Art/3D/Models',
    'Assets/Art/3D/Textures',
    'Assets/Art/3D/Materials',
    'Assets/Art/VFX',
    'Assets/Art/Shaders',
    'Assets/Art/References',
    'Assets/Audio/SFX',
    'Assets/Audio/Music',
    'Assets/Audio/Voice',
    'Assets/Audio/Mixers',
    'Assets/Animations/Clips',
    'Assets/Animations/Controllers',
    'Assets/Scenes',
    'Assets/Prefabs/Characters',
    'Assets/Prefabs/Environment',
    'Assets/Prefabs/UI',
    'Assets/Prefabs/Managers',
    'Assets/ScriptableObjects/Data',
    'Assets/ScriptableObjects/Events',
    'Assets/ScriptableObjects/Configs',
    'Assets/Settings',
    'Assets/Resources',
    'Assets/StreamingAssets',
    'Assets/Scripts/Core/Managers',
    'Assets/Scripts/Core/Events',
    'Assets/Scripts/Core/Interfaces',
    'Assets/Scripts/Core/Utilities',
    'Assets/Scripts/Systems',
    'Assets/Scripts/Features',
    'Assets/Scripts/UI',
    'Assets/Scripts/Editor',
    'Packages',
    'ProjectSettings',
    'Tests/EditMode',
    'Tests/PlayMode',
    '.github/workflows',
    'Documentation/Forge',
  ],
  unreal: [
    'Content/Art/2D/Sprites',
    'Content/Art/2D/UI',
    'Content/Art/3D/Models',
    'Content/Art/3D/Textures',
    'Content/Art/3D/Materials',
    'Content/Art/VFX',
    'Content/Art/Shaders',
    'Content/Art/References',
    'Content/Audio/SFX',
    'Content/Audio/Music',
    'Content/Audio/Voice',
    'Content/Blueprints/Core',
    'Content/Blueprints/UI',
    'Content/Blueprints/Gameplay',
    'Content/Maps',
    'Source',
    'Config',
    '.github/workflows',
    'Documentation/Forge',
  ],
  godot: [
    'assets/art/sprites',
    'assets/art/ui',
    'assets/art/models',
    'assets/art/textures',
    'assets/art/references',
    'assets/audio/sfx',
    'assets/audio/music',
    'assets/audio/voice',
    'assets/animations',
    'scenes',
    'scripts/core',
    'scripts/systems',
    'scripts/ui',
    'scripts/utils',
    'addons',
    '.github/workflows',
    'documentation/forge',
  ],
}

// ─── Ruta de destino de un asset según su formato y engine ───────────────────

function assetDestPath(engine, nodeKey, assetName, format) {
  const isPng = format === 'png' || format === 'image'
  const ext   = isPng        ? 'png'
              : format === 'docx' ? 'docx'
              : format === 'pptx' ? 'pptx'
              : 'md'

  if (isPng) {
    const ref = engine === 'unreal' ? 'Content/Art/References'
              : engine === 'godot'  ? 'assets/art/references'
              :                       'Assets/Art/References'
    return `${ref}/${nodeKey}/${assetName}.${ext}`
  }

  const docs = engine === 'godot' ? 'documentation/forge' : 'Documentation/Forge'
  return `${docs}/${nodeKey}/${assetName}.${ext}`
}

// ─── Root files ───────────────────────────────────────────────────────────────

function getGitignore(engine) {
  if (engine === 'unreal') return `# Unreal Engine
Binaries/
Build/
DerivedDataCache/
Intermediate/
Saved/
.vs/
*.sln
*.vcxproj*
.DS_Store
Thumbs.db
`
  if (engine === 'godot') return `# Godot
.godot/
export_presets.cfg
.import/
`
  // unity (default)
  return `# Unity generated
/[Ll]ibrary/
/[Tt]emp/
/[Oo]bj/
/[Bb]uild/
/[Bb]uilds/
/[Ll]ogs/
/[Uu]ser[Ss]ettings/
/[Mm]emory[Cc]aptures/
/[Aa]ssets/[Aa]ddon[Ss]/
*.csproj
*.unityproj
*.sln
*.suo
*.tmp
*.user
*.userprefs
*.pidb
*.booproj
sysinfo.txt
*.apk
*.aab
*.unitypackage
*.app
`
}

function getGitattributes(engine) {
  const common = `*.png filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.tga filter=lfs diff=lfs merge=lfs -text
*.psd filter=lfs diff=lfs merge=lfs -text
*.wav filter=lfs diff=lfs merge=lfs -text
*.mp3 filter=lfs diff=lfs merge=lfs -text
*.ogg filter=lfs diff=lfs merge=lfs -text
`
  if (engine === 'unity') return `# Unity LFS\n` + common + `*.fbx filter=lfs diff=lfs merge=lfs -text
*.FBX filter=lfs diff=lfs merge=lfs -text
*.blend filter=lfs diff=lfs merge=lfs -text
*.mp4 filter=lfs diff=lfs merge=lfs -text
*.unitypackage filter=lfs diff=lfs merge=lfs -text
`
  if (engine === 'unreal') return `# Unreal LFS\n` + common + `*.uasset filter=lfs diff=lfs merge=lfs -text
*.umap filter=lfs diff=lfs merge=lfs -text
*.fbx filter=lfs diff=lfs merge=lfs -text
`
  return `# Godot LFS\n` + common
}

function getEditorconfig() {
  return `root = true

[*]
indent_style = space
indent_size = 4
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.cs]
indent_size = 4

[*.json]
indent_size = 2

[*.md]
trim_trailing_whitespace = false
`
}

// ─── README generator ─────────────────────────────────────────────────────────

function generateReadme({ projectName, engine, conceptBrief, pushedAssets }) {
  const label  = engine === 'unity' ? 'Unity' : engine === 'unreal' ? 'Unreal Engine' : 'Godot'
  const folders = FOLDERS[engine] || FOLDERS.unity

  // Árbol de estructura (top-level, máximo 2 niveles)
  const treeLines = buildFolderTree(folders, pushedAssets)

  // Assets separados por categoría
  const docAssets = pushedAssets.filter(p =>
    p.toLowerCase().startsWith('documentation/') || p.toLowerCase().startsWith('docs/')
  )
  const artAssets = pushedAssets.filter(p =>
    p.toLowerCase().includes('/references/')
  )

  const assetSection = docAssets.length === 0 && artAssets.length === 0
    ? '_No Forge assets exported._'
    : [
        docAssets.length > 0 ? `### Design Documents\n\n${docAssets.map(p => `- \`${p}\``).join('\n')}` : '',
        artAssets.length > 0 ? `### Art References\n\n${artAssets.map(p => `- \`${p}\``).join('\n')}` : '',
      ].filter(Boolean).join('\n\n')

  return `# ${projectName}

> Scaffold generated by [Forge](https://forge.v57.studio) · Engine: **${label}**
${conceptBrief ? `\n## Concept\n\n${conceptBrief}\n` : ''}
---

## Project Structure

\`\`\`
${treeLines}
\`\`\`

---

## Forge Assets

${assetSection}

---

*Generated ${new Date().toISOString().split('T')[0]}*
`
}

// Construye el árbol de texto de la estructura de carpetas
function buildFolderTree(folders, pushedAssets) {
  // Recolectar todos los paths únicos (top-level y segundo nivel)
  const seen   = new Set()
  const lines  = []

  const allDirs = [
    ...folders,
    ...pushedAssets.map(p => p.split('/').slice(0, -1).join('/'))
  ]

  // Agrupar por primer segmento
  const roots = {}
  for (const dir of allDirs) {
    const parts = dir.split('/')
    const root  = parts[0]
    if (!roots[root]) roots[root] = new Set()
    if (parts[1]) roots[root].add(parts[1])
  }

  const rootKeys = Object.keys(roots).sort()
  rootKeys.forEach((root, ri) => {
    const isLastRoot = ri === rootKeys.length - 1
    lines.push(`${isLastRoot ? '└──' : '├──'} ${root}/`)
    const children = [...roots[root]].sort()
    children.forEach((child, ci) => {
      const isLastChild = ci === children.length - 1
      const prefix = isLastRoot ? '    ' : '│   '
      lines.push(`${prefix}${isLastChild ? '└──' : '├──'} ${child}/`)
    })
  })

  return lines.join('\n')
}

module.exports = { FOLDERS, assetDestPath, getGitignore, getGitattributes, getEditorconfig, generateReadme }
