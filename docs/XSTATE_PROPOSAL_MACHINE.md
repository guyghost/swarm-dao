# XState Proposal Lifecycle Machine

Gestion du cycle de vie complet des propositions via une state machine XState v5.

## Architecture

La machine gère le flow complet d'une proposition à travers 14+ états organisés en phases :

```
DRAFT → INTAKE → QUALIFICATION → ANALYSIS → CRITIQUE → SCORING
          ↓                    ↓ (rejection possible)
      REJECT

SCORING → COUNCIL → VOTING → APPROVAL
  ↓                             ↓
REJECT                    SPEC_DRAFT → SPEC_REVIEW
                                ↓ (rejection possible)
                           REJECT
                                ↓
                        EXECUTION_GATE
                             ↓
                         EXECUTING → POSTMORTEM → COMPLETED
                             ↓
                       EXECUTION_ERROR (with retry logic)
```

## Types

### ProposalContext
```typescript
interface ProposalContext {
  proposal: Proposal;           // La propositionelle-même
  stage: PipelineStage;        // Étape actuelle (intake, analysis, etc.)
  status: ProposalStatus;      // Statut (open, deliberating, approved, etc.)
  riskZone?: RiskZone;         // green, orange, red
  deliberationCount: number;   // Nombre de cycles de délibération
  retryCount: number;          // Nombre de tentatives d'exécution
  errorMessage?: string;       // Message d'erreur si applicable
  lastTransitionTime: string;  // Timestamp ISO8601 de la dernière transition
}
```

### ProposalEvent
Tous les événements possibles :
- `SUBMIT`, `QUALIFY`, `ANALYZE`, `CRITIQUE`, `SCORE`
- `SEND_TO_COUNCIL`, `VOTE`, `APPROVE`, `REJECT`
- `REQUEST_SPEC`, `REVIEW_SPEC`, `APPROVE_SPEC`
- `EXECUTION_GATE_PASS`, `EXECUTION_GATE_FAIL`, `EXECUTE`
- `EXECUTION_SUCCESS`, `EXECUTION_FAILED`, `POSTMORTEM`
- `RETRY`, `DISCARD`
- `ERROR` (avec message)

## Utilisation

### Créer un acteur pour une proposition

```typescript
import { createProposalActor } from '@guyghost/swarm-dao-core/governance';
import type { Proposal } from '@guyghost/swarm-dao-core/types';

const proposal: Proposal = {
  id: 1,
  title: "Add feature X",
  type: "product-feature",
  description: "...",
  proposedBy: "agent-1",
  status: "open",
  votes: [],
  agentOutputs: [],
  createdAt: new Date().toISOString(),
};

const actor = createProposalActor(proposal);
// L'acteur est automatiquement démarré dans l'état "draft"
```

### Transitionner l'état

```typescript
import { sendProposalEvent, getProposalState } from '@guyghost/swarm-dao-core/governance';

// Envoyer un événement
sendProposalEvent(actor, { type: "SUBMIT" });
console.log(getProposalState(actor)); // "intake"

sendProposalEvent(actor, { type: "QUALIFY" });
sendProposalEvent(actor, { type: "ANALYZE" });
console.log(getProposalState(actor)); // "analysis"
```

### Vérifier les transitions possibles

```typescript
import { canSendProposalEvent, getAvailableProposalEvents } from '@guyghost/swarm-dao-core/governance';

// Vérifier une transition spécifique
if (canSendProposalEvent(actor, "CRITIQUE")) {
  sendProposalEvent(actor, { type: "CRITIQUE" });
}

// Obtenir toutes les transitions possibles
const available = getAvailableProposalEvents(actor);
console.log(available); // ["CRITIQUE", "REJECT", ...]
```

### Récupérer le contexte

```typescript
import { getProposalContext } from '@guyghost/swarm-dao-core/governance';

const context = getProposalContext(actor);
console.log(context.stage);              // "analysis"
console.log(context.status);             // "deliberating"
console.log(context.deliberationCount);  // 1
console.log(context.lastTransitionTime); // "2026-06-06T00:06:39.173Z"
```

### Auto-progression dans le pipeline

```typescript
import { progressProposal } from '@guyghost/swarm-dao-core/governance';

// Progression linéaire à travers les états
const nextEvent = progressProposal(actor);
console.log(nextEvent); // "SUBMIT" → "QUALIFY" → "ANALYZE" → ...
```

### Gestion des changements d'état

```typescript
import { onProposalStateChange } from '@guyghost/swarm-dao-core/governance';

const unsubscribe = onProposalStateChange(actor, (state, context) => {
  console.log(`État: ${state}`);
  console.log(`Statut: ${context.status}`);
  console.log(`Délibérations: ${context.deliberationCount}`);
});

// Plus tard, arrêter l'écoute
unsubscribe();
```

### Flux complet d'approbation

```typescript
const actor = createProposalActor(proposal);

// Phase intake
sendProposalEvent(actor, { type: "SUBMIT" });      // draft → intake
sendProposalEvent(actor, { type: "QUALIFY" });     // intake → qualification

// Phase analyse
sendProposalEvent(actor, { type: "ANALYZE" });     // qualification → analysis
sendProposalEvent(actor, { type: "CRITIQUE" });    // analysis → critique
sendProposalEvent(actor, { type: "SCORE" });       // critique → scoring

// Phase conseil
sendProposalEvent(actor, { type: "SEND_TO_COUNCIL" }); // scoring → council
sendProposalEvent(actor, { type: "VOTE" });        // council → voting
sendProposalEvent(actor, { type: "APPROVE" });     // voting → specDraft

// Phase spécification
sendProposalEvent(actor, { type: "REQUEST_SPEC" }); // specDraft → specReview
sendProposalEvent(actor, { type: "APPROVE_SPEC" }); // specReview → executionGate

// Phase exécution
sendProposalEvent(actor, { type: "EXECUTION_GATE_PASS" }); // executionGate → executing
sendProposalEvent(actor, { type: "EXECUTION_SUCCESS" });   // executing → postmortem

const finalContext = getProposalContext(actor);
console.log(finalContext.status); // "executed"
```

### Gestion des erreurs et rejets

```typescript
// Rejet à n'importe quel moment
import { rejectProposal } from '@guyghost/swarm-dao-core/governance';

rejectProposal(actor);
console.log(getProposalState(actor)); // "rejected" (état final)

// Gestion des erreurs d'exécution avec retry
sendProposalEvent(actor, { type: "EXECUTION_FAILED" }); // executing → executionError

if (canSendProposalEvent(actor, "RETRY")) {
  sendProposalEvent(actor, { type: "RETRY" });
  // Réessaye tant que retryCount < 3
}

// Sinon, marquer comme échoué
sendProposalEvent(actor, { type: "EXECUTION_FAILED" }); // executionError → postmortem
```

## Caractéristiques clés

### ✅ Gestion d'état typée
- Types TypeScript strictes pour contexte et événements
- Propriétés immuables et garanties

### ✅ Tracking automatique
- **deliberationCount**: Incrémenté automatiquement pendant les phases d'analyse
- **retryCount**: Incrémenté à chaque tentative, réinitialisé à l'approbation
- **lastTransitionTime**: Mise à jour ISO8601 à chaque transition

### ✅ Validation des transitions
- Vérification des événements valides par état
- API `canSendProposalEvent()` pour prévalider

### ✅ États finaux
- `rejected`: Rejet permanent
- `completed`: Exécution réussie avec postmortem

### ✅ Observabilité
- Listeners pour surveiller les changements d'état
- Snapshots du contexte complet à tout moment

## Tests

Les 13 tests de couverture incluent :
- ✅ Création et initialisation
- ✅ Transitions individuelles
- ✅ Tracking des compteurs
- ✅ Validation des événements
- ✅ Auto-progression
- ✅ Gestion des rejets
- ✅ Timestamps
- ✅ Listeners/souscriptions
- ✅ Flux complets

Exécuter :
```bash
bun run test --filter "@guyghost/swarm-dao-core" -- proposal.machine.test.ts
```

## Prochaines étapes

- [ ] Ajouter des guards conditionnels (ex: quorum requis)
- [ ] Intégrer avec les services de vote
- [ ] Ajouter des side-effects d'audit
- [ ] Implémenter les amendes/modifications
- [ ] Ajouter la persistance du contexte
- [ ] State machine pour le cycle de vie du projet global
