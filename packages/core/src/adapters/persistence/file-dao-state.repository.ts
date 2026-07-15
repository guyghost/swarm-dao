import { promises as fs } from "node:fs";
import path from "node:path";
import type { DaoStateRepositoryPort } from "../../ports/repository.js";
import { createInitialState, type DAOState, type DecisionRecord } from "../../types/index.js";

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function repairState(value: Partial<DAOState>, daoRoot: string): DAOState {
  const fallback = createInitialState(daoRoot);
  const state = { ...fallback, ...value, daoRoot } as DAOState;
  state.proposals = Array.isArray(value.proposals) ? value.proposals : [];
  state.agents = Array.isArray(value.agents) ? value.agents : [];
  state.auditLog = Array.isArray(value.auditLog) ? value.auditLog : [];
  state.controlResults = value.controlResults && !Array.isArray(value.controlResults) ? value.controlResults : {};
  state.deliveryPlans = value.deliveryPlans && !Array.isArray(value.deliveryPlans) ? value.deliveryPlans : {};
  state.artefacts = value.artefacts && !Array.isArray(value.artefacts) ? value.artefacts : {};
  state.outcomes = value.outcomes && !Array.isArray(value.outcomes) ? value.outcomes : {};
  state.snapshots = value.snapshots && !Array.isArray(value.snapshots) ? value.snapshots : {};
  state.verifications = value.verifications && !Array.isArray(value.verifications) ? value.verifications : {};
  const nextProposalId = value.nextProposalId;
  const nextAuditId = value.nextAuditId;
  state.nextProposalId =
    typeof nextProposalId === "number" && Number.isInteger(nextProposalId) && nextProposalId > 0 ? nextProposalId : 1;
  state.nextAuditId =
    typeof nextAuditId === "number" && Number.isInteger(nextAuditId) && nextAuditId > 0 ? nextAuditId : 1;
  return state;
}

/** Instance-owned filesystem adapter. No process-global DAO state or write cache. */
export class FileDaoStateRepository implements DaoStateRepositoryPort {
  private readonly writeCache = new Map<string, string>();

  private constructor(
    private readonly state: DAOState,
    private readonly daoRoot: string,
  ) {}

  public static async open(cwd: string): Promise<FileDaoStateRepository> {
    const daoRoot = path.join(cwd, ".dao");
    await fs.mkdir(daoRoot, { recursive: true });
    const statePath = path.join(daoRoot, "state.json");
    let state = createInitialState(daoRoot);
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as Partial<DAOState>;
      state = repairState(parsed, daoRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FileDaoStateRepository(state, daoRoot);
  }

  public get(): DAOState {
    return this.state;
  }

  public async persist(): Promise<void> {
    await fs.mkdir(this.daoRoot, { recursive: true });
    await this.writeIfChanged(path.join(this.daoRoot, "state.json"), this.state);
    await this.persistDecisions();
  }

  private async persistDecisions(): Promise<void> {
    const decisionsDir = path.join(this.daoRoot, "decisions");
    await fs.mkdir(decisionsDir, { recursive: true });
    const decisions = this.state.proposals
      .filter((proposal) => proposal.status !== "open" && proposal.status !== "deliberating")
      .map(
        (proposal): DecisionRecord => ({
          id: proposal.id,
          title: proposal.title,
          type: proposal.type,
          status: proposal.status,
          riskZone: proposal.riskZone,
          createdAt: proposal.createdAt,
          resolvedAt: proposal.resolvedAt,
        }),
      )
      .sort((left, right) => left.id - right.id);
    await this.writeIfChanged(path.join(decisionsDir, "index.json"), decisions);
    await Promise.all(
      decisions.map((decision) =>
        this.writeIfChanged(path.join(decisionsDir, `${decision.id.toString().padStart(3, "0")}.json`), decision),
      ),
    );
  }

  private async writeIfChanged(filePath: string, value: unknown): Promise<void> {
    const serialized = formatJson(value);
    if (this.writeCache.get(filePath) === serialized) return;
    await fs.writeFile(filePath, serialized, "utf8");
    this.writeCache.set(filePath, serialized);
  }
}
