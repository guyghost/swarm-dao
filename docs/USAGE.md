# Guide d'utilisation — Swarm DAO dans Pi et OpenCode

> Installation, configuration et workflows complets pour Pi (extension) et OpenCode (plugin).

---

## Table des matières

- [Installation dans Pi](#installation-dans-pi)
- [Installation dans OpenCode](#installation-dans-opencode)
- [Workflows communs](#workflows-communs)
- [Différences Pi vs OpenCode](#différences-pi-vs-opencode)
- [Troubleshooting](#troubleshooting)

---

## Installation dans Pi

### Prérequis

- Pi coding agent (`pi`) installé
- Node.js ≥ 18
- Git

### 1. Cloner le repo

```bash
git clone https://github.com/guyghost/swarm-dao.git ~/swarm-dao
cd ~/swarm-dao
bun install
```

### 2. Configurer Pi

Dans votre projet Pi, éditer `pi.config.json` (ou le fichier de config Pi) :

```json
{
  "extensions": [
    {
      "package": "@swarm-dao/pi-adapter",
      "path": "/chemin/vers/swarm-dao/packages/pi-adapter"
    }
  ]
}
```

Ou installer via npm (après publication) :

```bash
pi install @swarm-dao/pi-adapter
```

### 3. Lancer Pi avec l'extension

```bash
pi --extension @swarm-dao/pi-adapter
```

### 4. Initialiser le DAO

Dans la session Pi :

```
> dao_setup

# DAO Initialized
# 7 agents configured:
# | Product Strategist | 3 | Vision, objectives, hypotheses |
# | Research Agent | 2 | Market, competition, user signals |
# | ...
```

### 5. Vérifier l'installation

```
> /dao

# Swarm DAO Dashboard
# Agents: 7 | Proposals: 0
```

---

## Installation dans OpenCode

### Prérequis

- OpenCode CLI (`opencode`) installé (≥ 1.14.19)
- Bun ≥ 1.3

### 1. Cloner le repo

```bash
git clone https://github.com/guyghost/swarm-dao.git ~/.config/opencode/plugins/swarm-dao
cd ~/.config/opencode/plugins/swarm-dao
bun install
```

### 2. Activer le plugin

Dans votre projet, éditer `.opencode/config.json` :

```json
{
  "plugins": ["swarm-dao"]
}
```

Ou via la CLI :

```bash
opencode plugin install swarm-dao
```

### 3. Lancer OpenCode

```bash
opencode
```

### 4. Initialiser le DAO

Dans la session OpenCode :

```
> dao_setup

# DAO Initialized
# 7 agents configured
# Run `dao_propose` to create proposals.
```

### 5. Vérifier l'installation

```
> dao_status

# DAO Status
# Agents: 7 active | Total weight: 15
# Proposals: 0
# Config: quorum=60%, approval=55%, risk=7/10
```

---

## Workflows communs

### Workflow 1 : Créer et délibérer une proposition

#### Dans Pi :

```
# Étape 1 : Créer une proposition
> dao_propose
  title="Add dark mode"
  type="product-feature"
  description="Implement a dark theme for the application"
  problemStatement="Users request dark mode for night usage"
  acceptanceCriteria=["Toggle works", "Persists preference"]
  successMetrics=["Adoption > 50%"]

# 📋 Proposal Created — #1

# Étape 2 : Délibrer (swarm automatique)
> dao_deliberate proposalId=1

# 🗳️ Deliberation Complete — #1
# Result: ✅ APPROVED
# Quorum: 85% / ✅ Met
# Approval Score: 73%

# Étape 3 : Contrôle qualité
> dao_check proposalId=1

# ✅ ALL GATES PASSED

# Étape 4 : Exécuter
> dao_execute proposalId=1

# ✅ Proposal Executed — #1
```

#### Dans OpenCode :

```
# Étape 1 : Créer une proposition
> dao_propose
  title="Add dark mode"
  type="product-feature"
  description="Implement a dark theme"

# 📋 Proposal Created — #1

# Étape 2 : Planifier la délibération (retourne un plan de dispatch)
> dao_deliberate proposalId=1

# 🐝 Dispatch Plan — Proposal #1
# Agents to spawn: 7
# ### @strategist
# Spawn this sub-agent with the following task...

# Étape 3 : Exécuter manuellement les sub-agents via `task`,
# puis enregistrer les outputs
> dao_record_outputs
  proposalId=1
  outputs=[
    { agentId: "strategist",
      content: "## Analysis...\n## Vote\nfor\n## Reasoning..." },
    { agentId: "architect",
      content: "## Analysis...\n## Vote\nfor\n## Reasoning..." },
    ...
  ]

# 🗳️ Deliberation Complete — #1

# Étape 4 : Contrôle + Exécution
> dao_control proposalId=1
> dao_execute proposalId=1
```

### Workflow 2 : Round Table (agents suggèrent)

#### Dans Pi :

```
> dao_roundtable

# 🎯 Round Table Results
# Suggestions: 5 valid / 0 unparsed / 0 errors
#
# ## Product Strategist
# **Title:** Add search functionality
# **Type:** product-feature
#
# ## Solution Architect
# **Title:** Migrate to TypeScript strict mode
# **Type:** technical-change
#
# **Created:** Proposals #2, #3, #4, #5, #6
```

#### Dans OpenCode :

```
> dao_roundtable

# Même résultat — les agents sont spawnés automatiquement
# via l'adapter OpenCode
```

### Workflow 3 : Dry-Run et Rollback

```
# Prévisualiser avant d'exécuter
> dao_dry_run proposalId=1

# 🔍 Dry-Run — Proposal #1
# Can Proceed: ✅ Yes
# Files Affected: src/theme.ts, src/components/
# Risks: None identified

# Exécuter
> dao_execute proposalId=1

# Si problème : rollback
> dao_rollback proposalId=1

# ⏪ Rollback Successful
# Proposal #1 rolled back to commit abc123de
```

### Workflow 4 : Dashboard et Artefacts

```
# Voir le dashboard
> dao_dashboard

# 🏛️ DAO Dashboard
# Proposals: 15 total
# Health: 78/100 Stable
# | Pass Rate      | ████████░░ 80% |
# | Avg Rating     | ████████░░ 78% |

# Générer les artefacts
> dao_artefacts proposalId=5

# 📦 Artefacts — Proposal #5
# | Decision Brief      | ✅ |
# | ADR                 | ✅ |
# | Risk Report         | ✅ |
# | PRD Lite            | ✅ |
# | Implementation Plan | ✅ |
# | Test Plan           | ✅ |
# | Release Packet      | ✅ |
```

### Workflow 5 : GitHub Integration

```
# Configurer
> dao_config_github
  token="ghp_xxx"
  owner="myorg"
  repo="myrepo"
  enabled=true

# Créer une branche
> dao_github_create_branch proposalId=1

# ✅ Branch ready
# Ref: refs/heads/dao/1-add-dark-mode

# Pousser le code, puis ouvrir une PR
> dao_github_open_pr
  proposalId=1
  headBranch="dao/1-add-dark-mode"

# ✅ Pull Request Opened
# PR: #42
# URL: https://github.com/myorg/myrepo/pull/42
```

---

## Différences Pi vs OpenCode

| Aspect | Pi | OpenCode |
|--------|-----|----------|
| **Type d'intégration** | Extension (`ExtensionAPI`) | Plugin (`@opencode-ai/plugin`) |
| **Installation** | `pi.config.json` extensions | `.opencode/config.json` plugins |
| **Deliberation** | Automatique (sub-process `pi --mode json`) | Manuelle (plan + `task` tool + `dao_record_outputs`) |
| **Sub-agents** | Spawnés automatiquement par le core | Spawnés manuellement via le `task` tool natif |
| **Événements** | `session_start`, `before_agent_start` | Hooks via le plugin API |
| **Commandes** | `/dao`, `/dao:propose`, etc. | `/dao/init`, `/dao/propose`, etc. |
| **Syntaxe tools** | `dao_propose title="..."` | `dao_propose({ title: "..." })` |
| **CLI standalone** | Via Pi | `opencode-dao` binaire inclus |

### Pourquoi la deliberation est différente ?

**Pi** peut spawn des sous-process Pi natifs :
```typescript
// Dans pi-adapter
await adapter.spawnAgent({ agent, proposal, systemPrompt });
// → Exécute `pi --mode json -p --no-session ...`
```

**OpenCode** ne peut pas spawn programmatically :
```typescript
// Dans opencode-adapter
// Étape 1: dao_deliberate retourne un plan markdown
// Étape 2: L'utilisateur spawn @dao-strategist via `task`
// Étape 3: dao_record_outputs ingère les résultats
```

---

## Troubleshooting

### Pi : "DAO not initialized"

```
> dao_setup
```

### OpenCode : "Plugin not found"

Vérifier le chemin du plugin :
```bash
ls ~/.config/opencode/plugins/swarm-dao/
# Devrait contenir package.json, src/, etc.
```

### Les agents ne répondent pas

Vérifier le modèle configuré :
```
> dao_config_show
```

### Erreur de compilation TypeScript

```bash
cd packages/core && npx tsc --noEmit
cd packages/pi-adapter && npx tsc --noEmit
cd packages/opencode-adapter && npx tsc --noEmit
```

### Reset complet

```bash
rm -rf .dao/
# Puis ré-initialiser
dao_setup
```

---

## Référence rapide des commandes

| Commande | Pi | OpenCode | Description |
|----------|-----|----------|-------------|
| Initialiser | `dao_setup` | `dao_setup` | Créer les 7 agents |
| Proposer | `dao_propose` | `dao_propose` | Créer proposition |
| Délibérer | `dao_deliberate` | `dao_deliberate` + `dao_record_outputs` | Swarm vote |
| Contrôler | `dao_check` | `dao_control` | Quality gates |
| Exécuter | `dao_execute` | `dao_execute` | Exécuter proposition |
| Artefacts | `dao_artefacts` | `dao_artefacts` | Générer documents |
| Dashboard | `dao_dashboard` | `dao_dashboard` | Vue d'ensemble |
| Dry-run | `dao_dry_run` | `dao_dry_run` | Prévisualiser |
| Rollback | `dao_rollback` | `dao_rollback` | Revenir en arrière |
| Roundtable | `dao_roundtable` | `dao_roundtable` | Suggestions agents |
| Audit | `dao_audit` | `dao_audit` | Historique |
| Status | `/dao` | `dao_status` | Dashboard rapide |

---

## Prochaines étapes

- [Configurer les agents](AGENT-PROMPTS.md)
- [Ajouter un nouvel hôte](EXTENSION-GUIDE.md)
- [Architecture détaillée](ADR-001-unified-architecture.md)