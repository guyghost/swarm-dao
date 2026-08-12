import type { AutonomyContract } from "./local-workspace.types.js";

export type PolicyField = "toolIds" | "maxBudgetActions" | "maxDepth" | "readRoots" | "writeRoots";

export type PolicyRequest = Readonly<{
  toolIds: readonly string[];
  budgetActions: number;
  depth: number;
  readPaths: readonly string[];
  writePaths: readonly string[];
}>;

export type SystemPolicyCeilings = Readonly<{
  toolIds: readonly string[];
  maxBudgetActions: number;
  maxDepth: number;
  readRoots: readonly string[];
  writeRoots: readonly string[];
}>;

export type GlobalPolicyRules = Readonly<{
  revision: string;
  toolIds: readonly string[];
  maxBudgetActions: number;
  maxDepth: number;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  overrideableFields: readonly PolicyField[];
}>;

export type ActivePolicyOverride = Readonly<{
  missionId: string;
  field: PolicyField;
  value: number | readonly string[];
  fingerprint: string;
}>;

export type PolicyEvaluationInput = Readonly<{
  request: PolicyRequest;
  systemCeilings: SystemPolicyCeilings;
  globalRules: GlobalPolicyRules;
  missionContract: AutonomyContract;
  activeOverrides: readonly ActivePolicyOverride[];
}>;

export type PolicyDecision = Readonly<{
  decision: "allow" | "requires_human_confirmation" | "deny";
  reasonCodes: readonly string[];
  policyRevision: string;
}>;

export type PolicyOverrideDiff = Readonly<{
  field: "maxBudgetActions" | "maxDepth";
  from: number;
  to: number;
}>;

const allIn = (requested: readonly string[], allowed: readonly string[]): boolean =>
  requested.every((value) => allowed.includes(value));

const isInsideRoot = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

const pathsInside = (paths: readonly string[], roots: readonly string[]): boolean =>
  paths.every((path) => path.startsWith("/") && roots.some((root) => isInsideRoot(path, root)));

const overrideNumber = (input: PolicyEvaluationInput, field: PolicyOverrideDiff["field"]): number | null => {
  const active = input.activeOverrides.find((override) => override.field === field);
  return active && typeof active.value === "number" ? active.value : null;
};

export const evaluatePolicy = (input: PolicyEvaluationInput): PolicyDecision => {
  const { request, systemCeilings, globalRules, missionContract } = input;
  const policyRevision = globalRules.revision;
  const systemViolation =
    !allIn(request.toolIds, systemCeilings.toolIds) ||
    request.budgetActions > systemCeilings.maxBudgetActions ||
    request.depth > systemCeilings.maxDepth ||
    !pathsInside(request.readPaths, systemCeilings.readRoots) ||
    !pathsInside(request.writePaths, systemCeilings.writeRoots);
  if (systemViolation) return { decision: "deny", reasonCodes: ["system_ceiling_exceeded"], policyRevision };

  const toolDenied =
    !allIn(request.toolIds, globalRules.toolIds) || !allIn(request.toolIds, missionContract.allowedToolIds);
  const readDenied =
    !pathsInside(request.readPaths, globalRules.readRoots) ||
    !pathsInside(request.readPaths, missionContract.fileAccessRules.readRoots);
  const writeDenied =
    !pathsInside(request.writePaths, globalRules.writeRoots) ||
    !pathsInside(request.writePaths, missionContract.fileAccessRules.writeRoots);
  const depthLimit = Math.min(globalRules.maxDepth, missionContract.delegationLimits.maxDepth);
  const depthOverride = overrideNumber(input, "maxDepth");
  const budgetLimit = Math.min(globalRules.maxBudgetActions, missionContract.budgetLimits.maxActions);
  const budgetOverride = overrideNumber(input, "maxBudgetActions");

  if (toolDenied || readDenied || writeDenied) {
    return { decision: "deny", reasonCodes: ["policy_denied"], policyRevision };
  }
  if (request.depth > (depthOverride ?? depthLimit)) {
    return globalRules.overrideableFields.includes("maxDepth")
      ? { decision: "requires_human_confirmation", reasonCodes: ["human_confirmation_required"], policyRevision }
      : { decision: "deny", reasonCodes: ["policy_denied"], policyRevision };
  }
  if (request.budgetActions > (budgetOverride ?? budgetLimit)) {
    return globalRules.overrideableFields.includes("maxBudgetActions")
      ? { decision: "requires_human_confirmation", reasonCodes: ["human_confirmation_required"], policyRevision }
      : { decision: "deny", reasonCodes: ["policy_denied"], policyRevision };
  }
  return { decision: "allow", reasonCodes: [], policyRevision };
};

export const validatePolicyOverride = (
  diff: PolicyOverrideDiff,
  policy: PolicyEvaluationInput,
): "allowed" | "system_ceiling_exceeded" | "field_not_overrideable" => {
  const systemLimit =
    diff.field === "maxBudgetActions" ? policy.systemCeilings.maxBudgetActions : policy.systemCeilings.maxDepth;
  if (diff.to > systemLimit) return "system_ceiling_exceeded";
  if (!policy.globalRules.overrideableFields.includes(diff.field)) return "field_not_overrideable";
  return "allowed";
};
