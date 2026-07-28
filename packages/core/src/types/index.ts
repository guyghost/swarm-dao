// ============================================================
// Swarm DAO Core — Type Definitions (Unified)
// ============================================================

// ── Proposal Types ───────────────────────────────────────────

export const PROPOSAL_TYPE = {
  PRODUCT_FEATURE: "product-feature",
  SECURITY_CHANGE: "security-change",
  TECHNICAL_CHANGE: "technical-change",
  RELEASE_CHANGE: "release-change",
  GOVERNANCE_CHANGE: "governance-change",
} as const;

/** Typed proposal categories — each maps to a council and approval flow */
export type ProposalType = (typeof PROPOSAL_TYPE)[keyof typeof PROPOSAL_TYPE];

export const PROPOSAL_TYPES: ProposalType[] = Object.values(PROPOSAL_TYPE);

export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  [PROPOSAL_TYPE.PRODUCT_FEATURE]: "✨ Product Feature",
  [PROPOSAL_TYPE.SECURITY_CHANGE]: "🔒 Security Change",
  [PROPOSAL_TYPE.TECHNICAL_CHANGE]: "⚙️ Technical Change",
  [PROPOSAL_TYPE.RELEASE_CHANGE]: "📦 Release Change",
  [PROPOSAL_TYPE.GOVERNANCE_CHANGE]: "📜 Governance Change",
};

// ── Councils ─────────────────────────────────────────────────

export type Council =
  | "product-council"
  | "security-council"
  | "delivery-council"
  | "governance-council"
  | "user-council";

export const PROPOSAL_COUNCIL: Record<ProposalType, Council[]> = {
  [PROPOSAL_TYPE.PRODUCT_FEATURE]: ["product-council", "user-council"],
  [PROPOSAL_TYPE.SECURITY_CHANGE]: ["security-council"],
  [PROPOSAL_TYPE.TECHNICAL_CHANGE]: ["product-council", "delivery-council", "user-council"],
  [PROPOSAL_TYPE.RELEASE_CHANGE]: ["delivery-council", "security-council", "user-council"],
  [PROPOSAL_TYPE.GOVERNANCE_CHANGE]: ["governance-council"],
};

// ── Risk Zones ───────────────────────────────────────────────

export type RiskZone = "green" | "orange" | "red";

export const RISK_ZONE_LABELS: Record<RiskZone, string> = {
  green: "🟢 Green",
  orange: "🟠 Orange",
  red: "🔴 Red",
};

export const RISK_ZONE_DEFINITIONS: Record<
  RiskZone,
  {
    criteria: string;
    process: string;
    humanApprovals: number;
    requiresSecurityReview: boolean;
    requiresFormalVote: boolean;
  }
> = {
  green: {
    criteria: "Minor UI, docs, text, light instrumentation",
    process: "Agent auto-approval + async human review",
    humanApprovals: 1,
    requiresSecurityReview: false,
    requiresFormalVote: false,
  },
  orange: {
    criteria: "Non-trivial features, moderate refactors, limited new integrations",
    process: "Council review + QA checklist",
    humanApprovals: 2,
    requiresSecurityReview: false,
    requiresFormalVote: false,
  },
  red: {
    criteria: "New permissions, multi-site access, auth, sensitive storage, store publication",
    process: "Security Council + reinforced quorum + final human approval",
    humanApprovals: 2,
    requiresSecurityReview: true,
    requiresFormalVote: true,
  },
};

// ── Per-Type Quorum ──────────────────────────────────────────

export interface TypeQuorumConfig {
  quorumPercent: number;
  approvalPercent: number;
  description: string;
}

export const TYPE_QUORUM: Record<ProposalType, TypeQuorumConfig> = {
  [PROPOSAL_TYPE.GOVERNANCE_CHANGE]: { quorumPercent: 70, approvalPercent: 66, description: "Governance / Policy" },
  [PROPOSAL_TYPE.PRODUCT_FEATURE]: { quorumPercent: 60, approvalPercent: 55, description: "Product Roadmap" },
  [PROPOSAL_TYPE.SECURITY_CHANGE]: { quorumPercent: 75, approvalPercent: 70, description: "Security-sensitive" },
  [PROPOSAL_TYPE.TECHNICAL_CHANGE]: { quorumPercent: 60, approvalPercent: 55, description: "Technical / Architecture" },
  [PROPOSAL_TYPE.RELEASE_CHANGE]: { quorumPercent: 50, approvalPercent: 51, description: "Routine Release" },
};

// ── Pipeline Stages ──────────────────────────────────────────

export type PipelineStage =
  | "intake"
  | "qualification"
  | "analysis"
  | "critique"
  | "scoring"
  | "council"
  | "vote"
  | "spec"
  | "execution-gate"
  | "postmortem";

export const PIPELINE_STAGES: PipelineStage[] = [
  "intake",
  "qualification",
  "analysis",
  "critique",
  "scoring",
  "council",
  "vote",
  "spec",
  "execution-gate",
  "postmortem",
];

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  intake: "📋 Intake",
  qualification: "🔍 Qualification",
  analysis: "🧪 Analysis",
  critique: "🔎 Critique",
  scoring: "📊 Scoring",
  council: "🏛️ Council",
  vote: "🗳️ Vote",
  spec: "📝 Spec",
  "execution-gate": "🛡️ Execution Gate",
  postmortem: "📖 Postmortem",
};

// ── Composite Scoring ────────────────────────────────────────

export interface AxisScore {
  userImpact: number; // 30%
  businessImpact: number; // 20%
  effort: number; // 15% (inverted)
  securityRisk: number; // 20% (inverted)
  confidence: number; // 15%
}

export const SCORING_WEIGHTS: Record<keyof AxisScore, number> = {
  userImpact: 0.3,
  businessImpact: 0.2,
  effort: 0.15,
  securityRisk: 0.2,
  confidence: 0.15,
};

export interface CompositeScore {
  axes: AxisScore;
  weighted: number; // 0-10
  riskZone: RiskZone;
  breakdown: string;
}

// ── RICE Scoring ─────────────────────────────────────────────

export interface RICEScore {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
  riceScore: number;
  rank?: number;
}

// ── Proposal Content (V2) ────────────────────────────────────

export interface ProposalContent {
  title: string;
  type: ProposalType;
  problemStatement: string;
  targetUser: string;
  expectedOutcome: string;
  successMetrics: string[];
  scopeIn: string[];
  scopeOut: string[];
  permissionsImpact: string[];
  dataImpact: string[];
  technicalOptions: string[];
  risks: string[];
  dependencies: string[];
  estimatedEffort: string;
  confidenceScore: number;
  recommendedDecision: string;
}

// ── Acceptance Criteria ──────────────────────────────────────

export interface AcceptanceCriterion {
  id: string;
  given: string;
  when: string;
  then: string;
  met?: boolean;
  evidence?: string;
}

// ── Proposal Status ──────────────────────────────────────────

export type ProposalStatus = "open" | "deliberating" | "approved" | "controlled" | "rejected" | "executed" | "failed";

// ── Voting ───────────────────────────────────────────────────

export type VotePosition = "for" | "against" | "abstain";

export interface Vote {
  agentId: string;
  agentName: string;
  position: VotePosition;
  reasoning: string;
  weight: number;
}

export interface AgentOutput {
  agentId: string;
  agentName: string;
  role: string;
  content: string;
  vote?: Vote;
  durationMs: number;
  error?: string;
}

// ── Agents ───────────────────────────────────────────────────

export type AgentRiskLevel = "low" | "medium" | "high" | "critical";

export interface StopCondition {
  type: "timeout" | "error" | "threshold" | "manual";
  description: string;
  value?: string;
}

export interface AgentKPI {
  name: string;
  description: string;
  target: string;
}

export interface CouncilMembership {
  council: Council;
  role: "lead" | "member" | "advisor";
}

// ── Delegation (DFI thin slice) ──────────────────────────────
//
// Delegated Facet Investigation. An agent may declare the facets it can
// delegate to a dedicated sub-agent. The lifecycle of each delegation is
// owned by the delegation state machines (`governance/delegation.machine.ts`)
// — these types are the persisted shape, NOT the transition logic. The model
// decides; an LLM only emits a `FACET_REQUESTED` signal.

/**
 * Open registry key for a delegation profile. Kept as a plain string so a DAO
 * can extend the roster without editing the core union. Profiles live in
 * `DAOConfig.delegationProfile`.
 */
export type DelegationArchetype = string;

/**
 * Facet token. Carried raw by the LLM signal, normalized (trim + lower-case)
 * by the orchestrator before it reaches a machine. Matching is exact on the
 * normalized token (INV-5).
 */
export type DelegationFacet = string;

/**
 * A declared delegation capability of an agent. Declares WHAT may be
 * delegated and to which archetype — never HOW (no budget, no status). Budget
 * lives exclusively in `DAOConfig.delegation`.
 */
export interface DelegationSpec {
  facet: DelegationFacet;
  archetype: DelegationArchetype;
  /**
   * `"inherit"` (or omitted) ⇒ the child resolves to the parent agent's
   * resolved model. Any other non-empty string is an explicit override and is
   * audited. See `intelligence/model.ts` for the full chain.
   */
  model?: "inherit" | string;
}

export interface DAOAgent {
  id: string;
  name: string;
  role: string;
  description: string;
  weight: number;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  owner?: string;
  mission?: string;
  authorizedInputs?: string[];
  authorizedData?: string[];
  riskLevel?: AgentRiskLevel;
  authorizedEnvironments?: string[];
  stopConditions?: StopCondition[];
  kpis?: AgentKPI[];
  councils?: CouncilMembership[];
  enabled?: boolean;
  /**
   * Declared delegation capabilities. Presence of a non-empty array does NOT
   * enable delegation on its own — `DAOConfig.delegation.enabled` must be true
   * (the `parentEnabled` guard in `DelegationCoordinator`).
   */
  delegates?: DelegationSpec[];
}

// ── Configuration ────────────────────────────────────────────

export interface HealthWeights {
  passRate: number;
  avgRating: number;
  deliberationDepth: number;
  participation: number;
}

export interface DAOConfig {
  quorumPercent: number;
  approvalThreshold: number;
  defaultModel: string;
  maxConcurrent: number;
  riskThreshold: number;
  requiredGates: string[];
  typeQuorum: Partial<Record<ProposalType, TypeQuorumConfig>>;
  quorumFloor: number;
  staleThresholdHours?: number;
  healthWeights?: HealthWeights;
  /**
   * Delegation budget and behaviour. Single source of truth for budget (INV-1,
   * INV-7). Defaults to disabled to preserve back-compat for existing DAOs.
   */
  delegation?: DelegationConfig;
  /**
   * Per-archetype profile. `defaultModel` (if set) sits between the child
   * override and the parent agent's resolved model in the inheritance chain.
   */
  delegationProfile?: Partial<Record<DelegationArchetype, DelegationProfileEntry>>;
}

/**
 * Budget + behaviour for Delegated Facet Investigation. All four fields are
 * authoritative; `agent.delegates` carries NO budget (B4 — single source).
 */
export interface DelegationConfig {
  /** Master switch for the `parentEnabled` guard. Default `false`. */
  enabled: boolean;
  /** Depth cap. Thin slice is fixed at 1 — a child cannot become a coordinator. */
  maxDepth: number;
  /** Max in-flight children per parent. Enforced atomically by the coordinator actor. */
  maxChildrenPerParent: number;
  /** Hard ceiling on the fold step; on expiry the request → `failed`. */
  foldTimeoutMs: number;
}

export interface DelegationProfileEntry {
  /** Model used when a child does not override and the parent is not inherited. */
  defaultModel?: string;
  /** Prompt template id the child agent is spawned with. */
  promptId: string;
}

export const DEFAULT_CONFIG: DAOConfig = {
  quorumPercent: 60,
  approvalThreshold: 55,
  defaultModel: "z.ai/GLM-5.1",
  maxConcurrent: 4,
  riskThreshold: 7,
  requiredGates: [
    "quorum-quality",
    "risk-threshold",
    "vote-consensus",
    "zone-compliance",
    "acceptance-criteria",
    "dependency-readiness",
    "dependency-conflict",
    "mandatory-dry-run",
    "type-specific-quality",
  ],
  typeQuorum: TYPE_QUORUM,
  quorumFloor: 60,
  staleThresholdHours: 24,
};

/**
 * Default delegation config: disabled by default (back-compat). When a DAO
 * opts in, the thin slice caps depth at 1 and children-per-parent at 3.
 * `delegation-closed` is an opt-in control gate — it is intentionally absent
 * from `DEFAULT_CONFIG.requiredGates`.
 */
export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  enabled: false,
  maxDepth: 1,
  maxChildrenPerParent: 3,
  foldTimeoutMs: 30_000,
};

// ── Core Proposal ────────────────────────────────────────────

export interface Proposal {
  id: number;
  title: string;
  type: ProposalType;
  description: string;
  context?: string;
  problemStatement?: string;
  acceptanceCriteria?: AcceptanceCriterion[] | string[];
  successMetrics?: string[];
  rollbackConditions?: string[];
  affectedPaths?: string[];

  // Structured content (V2)
  content?: ProposalContent;

  // Risk & Scoring
  riskZone?: RiskZone;
  compositeScore?: CompositeScore;
  riceScore?: RICEScore;

  // Pipeline
  stage?: PipelineStage;

  proposedBy: string;
  status: ProposalStatus;
  votes: Vote[];
  agentOutputs: AgentOutput[];
  synthesis?: string;
  executionResult?: string;

  // Postmortem
  postmortem?: Postmortem;

  // Self-Amending
  amendmentPayload?: AmendmentPayload;
  amendmentOrigin?: AmendmentOrigin;
  amendmentState?: AmendmentState;
  preAmendmentSnapshot?: AmendmentSnapshot;

  // Inter-proposal dependencies (explicit proposal IDs)
  dependsOn?: number[];

  // Dry-Run
  dryRunAt?: string;
  dryRunCanProceed?: boolean;

  createdAt: string;
  resolvedAt?: string;
}

export interface Postmortem {
  outcome: "success" | "partial" | "failed";
  metrics: { name: string; expected: string; actual: string }[];
  learnings: string[];
  followUpActions: string[];
  recordedAt: string;
  recordedBy: string;
}

// ── Amendments ───────────────────────────────────────────────

export type AmendmentType =
  | "agent-update"
  | "agent-add"
  | "agent-remove"
  | "config-update"
  | "quorum-update"
  | "gate-update"
  | "council-update";

export interface AmendmentOrigin {
  source: "human" | "agent";
  agentId?: string;
}

export type AmendmentState = "pending-vote" | "approved-pending-human" | "approved" | "executed" | "rolled-back";

export interface AmendmentSnapshot {
  agents: DAOAgent[];
  config: DAOConfig;
  capturedAt: string;
}

export interface AgentUpdatePayload {
  type: "agent-update";
  agentId: string;
  changes: Partial<Omit<DAOAgent, "id">>;
}

export interface AgentAddPayload {
  type: "agent-add";
  agent: Omit<DAOAgent, "systemPrompt"> & { systemPrompt?: string };
}

export interface AgentRemovePayload {
  type: "agent-remove";
  agentId: string;
}

export interface ConfigUpdatePayload {
  type: "config-update";
  changes: Partial<Omit<DAOConfig, "typeQuorum">>;
}

export interface QuorumUpdatePayload {
  type: "quorum-update";
  typeQuorum: Partial<Record<ProposalType, Partial<TypeQuorumConfig>>>;
}

export interface GateUpdatePayload {
  type: "gate-update";
  addGates?: string[];
  removeGates?: string[];
}

export interface CouncilUpdatePayload {
  type: "council-update";
  agentId: string;
  councils: CouncilMembership[];
}

export type AmendmentPayload =
  | AgentUpdatePayload
  | AgentAddPayload
  | AgentRemovePayload
  | ConfigUpdatePayload
  | QuorumUpdatePayload
  | GateUpdatePayload
  | CouncilUpdatePayload;

// ── Control Layer ────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  timestamp: string;
  proposalId: number;
  layer: "governance" | "intelligence" | "delivery" | "control";
  action: string;
  actor: string;
  details: string;
  metadata?: Record<string, unknown>;
}

export interface GateResult {
  gateId: string;
  name: string;
  passed: boolean;
  severity: "blocker" | "warning" | "info";
  message: string;
  details?: Record<string, unknown>;
}

export interface ChecklistItem {
  id: string;
  category: "security" | "compliance" | "quality" | "operational";
  label: string;
  checked: boolean;
  autoChecked: boolean;
  details?: string;
}

export interface ControlCheckResult {
  proposalId: number;
  timestamp: string;
  allGatesPassed: boolean;
  blockerCount: number;
  warningCount: number;
  gates: GateResult[];
  checklist: ChecklistItem[];
}

// ── Delivery ─────────────────────────────────────────────────

export interface DeliveryTask {
  id: string;
  title: string;
  description: string;
  effort: "xs" | "s" | "m" | "l" | "xl";
  phase: number;
  dependencies: string[];
  status: "pending" | "in_progress" | "done";
}

export interface DeliveryPhase {
  number: number;
  name: string;
  tasks: DeliveryTask[];
  duration: string;
}

export interface DeliveryPlan {
  proposalId: number;
  createdAt: string;
  phases: DeliveryPhase[];
  branchStrategy: string;
  rollbackPlan: string;
  estimatedDuration: string;
}

export interface ExecutionSnapshot {
  proposalId: number;
  timestamp: string;
  branch: string;
  commitSha: string;
  filesChanged: string[];
  stateSnapshot: string;
}

export interface DryRunResult {
  proposalId: number;
  preview: string;
  filesAffected: string[];
  risks: string[];
  estimatedDuration: string;
  canProceed: boolean;
}

export type VerificationStatus = "unverified" | "success" | "partial" | "failed";

export interface ExecutionVerification {
  proposalId: number;
  status: VerificationStatus;
  timestamp: string;
  filesChanged: string[];
  missingFiles: string[];
  testOutput?: string;
  testsPassed?: number;
  testsFailed?: number;
  compilationOk: boolean;
  gitClean: boolean;
  summary: string;
}

// ── Outcome Tracking ─────────────────────────────────────────

export interface OutcomeRating {
  proposalId: number;
  rater: string;
  score: 1 | 2 | 3 | 4 | 5;
  comment: string;
  ratedAt: string;
}

export interface MetricSnapshot {
  name: string;
  before: string;
  after: string;
  unit?: string;
  capturedAt: string;
}

export interface ProposalOutcome {
  proposalId: number;
  ratings: OutcomeRating[];
  metrics: MetricSnapshot[];
  overallScore: number;
  status: "pending" | "tracked" | "reviewed";
  createdAt: string;
  updatedAt: string;
}

// ── Health Score ─────────────────────────────────────────────

export interface HealthMetric {
  name: string;
  rawValue: number;
  normalizedScore: number;
  weight: number;
  contribution: number;
  displayValue: string;
}

export interface HealthScore {
  score: number;
  label: string;
  metrics: HealthMetric[];
  insufficientData: boolean;
  proposalCount: number;
}

export interface HealthSnapshot {
  weekKey: string;
  year: number;
  week: number;
  score: number;
  metrics: HealthMetric[];
  proposalCount: number;
  createdAt: string;
}

// ── Gate Schemas ─────────────────────────────────────────────

export interface SchemaField {
  name: string;
  label: string;
  accessor: (proposal: Proposal) => unknown;
  validator: (value: unknown) => boolean;
}

export interface GateSchema {
  proposalType: ProposalType;
  requiredFields: { name: string; label: string; validator: (proposal: Proposal) => boolean }[];
  requiredSections: { heading: string; label: string }[];
  riskThresholdOverride?: number;
  description: string;
}

export interface SchemaValidationResult {
  passed: boolean;
  gateId: string;
  name: string;
  severity: "blocker" | "warning" | "info";
  message: string;
  failures: { field?: string; section?: string; expected: string; actual: string }[];
  details?: Record<string, unknown>;
}

// ── State ────────────────────────────────────────────────────

export interface DAOState {
  agents: DAOAgent[];
  proposals: Proposal[];
  config: DAOConfig;
  nextProposalId: number;
  initialized: boolean;
  auditLog: AuditEntry[];
  nextAuditId: number;
  controlResults: Record<number, ControlCheckResult>;
  deliveryPlans: Record<number, DeliveryPlan>;
  artefacts: Record<number, DAOArtefacts>;
  outcomes: Record<number, ProposalOutcome>;
  snapshots: Record<number, ExecutionSnapshot>;
  verifications: Record<number, ExecutionVerification>;
  hostContext?: HostProjectContext;
  healthSnapshots?: HealthSnapshot[];
  daoRoot: string;
}

export interface HostProjectContext {
  rootDir: string;
  repoName: string;
  repoOwner: string;
  repoSlug: string;
  branch: string;
  language: string;
  framework: string;
  packageManager: string;
  isSelfRepo: boolean;
}

// ── Decision Record ──────────────────────────────────────────

export interface DecisionRecord {
  id: number;
  title: string;
  type: ProposalType;
  status: ProposalStatus;
  riskZone?: RiskZone;
  createdAt: string;
  resolvedAt?: string;
}

// ── Results ──────────────────────────────────────────────────

export interface TallyResult {
  proposalId: number;
  approved: boolean;
  quorumMet: boolean;
  totalAgents: number;
  votingAgents: number;
  quorumPercent: number;
  weightedFor: number;
  weightedAgainst: number;
  totalVotingWeight: number;
  approvalScore: number;
  votes: Vote[];
}

export interface DeliberationResult {
  proposalId: number;
  proposal: Proposal;
  agentOutputs: AgentOutput[];
  synthesis: string;
  tally: TallyResult;
  status: "approved" | "rejected";
  durationMs: number;
}

// ── Artefacts ────────────────────────────────────────────────

export interface DecisionBrief {
  proposalId: number;
  title: string;
  type: ProposalType;
  objective: string;
  summary: string;
  approvalScore: number;
  quorumPercent: number;
  decision: "approved" | "rejected";
  date: string;
  keyAgents: { name: string; position: VotePosition; weight: number }[];
}

export interface ADR {
  proposalId: number;
  adrId: string;
  title: string;
  status: "proposed" | "accepted" | "deprecated" | "superseded";
  context: string;
  decision: string;
  options: { name: string; description: string; selected: boolean; pros: string[]; cons: string[] }[];
  consequences: string[];
  rejectedAlternatives: string[];
}

export interface RiskReport {
  proposalId: number;
  overallRiskScore: number;
  riskLevel: AgentRiskLevel;
  risks: {
    category: string;
    description: string;
    severity: "low" | "medium" | "high" | "critical";
    likelihood: "low" | "medium" | "high";
    mitigation: string;
  }[];
  permissions: string[];
  dataSurfaces: string[];
  guardrails: string[];
}

export interface PRDLite {
  proposalId: number;
  objective: string;
  userStories: {
    id: string;
    title: string;
    asA: string;
    iWant: string;
    soThat: string;
    acceptanceCriteria: string[];
  }[];
  inScope: string[];
  outOfScope: string[];
  metrics: { name: string; baseline: string; target: string }[];
  openQuestions: string[];
}

export interface ImplementationPlan {
  proposalId: number;
  phases: {
    number: number;
    name: string;
    tasks: { id: string; title: string; effort: string; dependencies: string[] }[];
  }[];
  branchStrategy: string;
  estimatedDuration: string;
  criticalPath: string[];
}

export interface TestPlan {
  proposalId: number;
  unitTests: { target: string; description: string }[];
  integrationTests: { target: string; description: string }[];
  e2eTests: { scenario: string; steps: string }[];
  nonRegressionChecks: string[];
  testEnvironments: string[];
}

export interface ReleasePacket {
  proposalId: number;
  version: string;
  changelog: string;
  releaseNotes: string;
  preReleaseChecklist: { item: string; checked: boolean }[];
  rollbackPlan: string;
  storeNotes: string;
}

export interface ArtefactFileReference {
  path: string;
  url?: string;
}

export interface ArtefactFileIndex {
  decisionBrief: ArtefactFileReference;
  adr: ArtefactFileReference;
  riskReport: ArtefactFileReference;
  prdLite: ArtefactFileReference;
  implementationPlan: ArtefactFileReference;
  testPlan: ArtefactFileReference;
  releasePacket: ArtefactFileReference;
}

export interface DAOArtefacts {
  proposalId: number;
  generatedAt: string;
  decisionBrief: DecisionBrief;
  adr: ADR;
  riskReport: RiskReport;
  prdLite: PRDLite;
  implementationPlan: ImplementationPlan;
  testPlan: TestPlan;
  releasePacket: ReleasePacket;
  files?: ArtefactFileIndex;
}

// ── Storage Settings ─────────────────────────────────────────

export interface StorageSettings {
  mode: "local" | "github" | "hybrid";
  githubSyncEnabled: boolean;
  daoRoot: string;
  githubRepo?: string;
}

// ── Host Adapter Interface ───────────────────────────────────

/**
 * Interface that every host adapter must implement.
 * The core is host-agnostic — it calls these methods to interact
 * with the outside world (spawn agents, read files, etc.)
 */
export interface HostAdapter {
  /** Unique identifier for this host */
  readonly hostId: string;

  /** Spawn a single agent and return its output */
  spawnAgent(params: {
    agent: DAOAgent;
    proposal: Proposal;
    systemPrompt: string;
    model?: string;
    timeoutMs?: number;
  }): Promise<AgentOutput>;

  /** Spawn multiple agents concurrently (up to maxConcurrent) */
  spawnAgents(params: { agents: DAOAgent[]; proposal: Proposal; maxConcurrent: number }): Promise<AgentOutput[]>;

  /** Return the current host session model, if available */
  getSessionModel?(): string | undefined;

  /** Log a message to the host's logging system */
  log(params: { level: "info" | "warn" | "error"; message: string; service: string }): Promise<void>;

  /** Get the current working directory */
  getWorkingDirectory(): string;

  /** Read a file from disk */
  readFile(path: string): Promise<string>;

  /** Write a file to disk */
  writeFile(path: string, content: string): Promise<void>;

  /** Execute a shell command */
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /** Check if the host has a specific capability */
  hasCapability(capability: string): boolean;
}

// ── Defaults ─────────────────────────────────────────────────

export function createInitialState(daoRoot: string): DAOState {
  return {
    agents: [],
    proposals: [],
    config: { ...DEFAULT_CONFIG, typeQuorum: { ...TYPE_QUORUM } },
    nextProposalId: 1,
    initialized: false,
    auditLog: [],
    nextAuditId: 1,
    controlResults: {},
    deliveryPlans: {},
    artefacts: {},
    outcomes: {},
    snapshots: {},
    verifications: {},
    daoRoot,
  };
}
