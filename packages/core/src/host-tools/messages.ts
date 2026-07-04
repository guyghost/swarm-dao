import { buildDaoCommandHelp, type DaoCommandHost } from "../commands/registry.js";

export const DAO_ONBOARDING_MESSAGE = [
  "# DAO not initialized",
  "",
  "1. Run `dao_setup` to create the default governance agents.",
  "2. Run `dao_help` to see the full workflow and available commands.",
  '3. Start your first proposal with `dao_propose title="..." type="product-feature" description="..."`.',
].join("\n");

export interface BuildDaoHelpMessageOptions {
  manualDeliberation?: boolean;
  controlTool?: string;
  /** Filter the command catalogue to a single host (default: all commands). */
  host?: DaoCommandHost;
  /** Render only the procedural flow, without the full command catalogue. */
  hideCatalogue?: boolean;
}

export function buildDaoHelpMessage(options: BuildDaoHelpMessageOptions = {}): string {
  const manualDeliberation = options.manualDeliberation ?? true;
  const controlTool = options.controlTool ?? "dao_control";

  const deliberationSteps = manualDeliberation
    ? [
        "3. `dao_deliberate proposalId=1`",
        "4. Spawn sub-agents via your host's task/agent tool using the dispatch plan",
        "5. `dao_record_outputs proposalId=1 outputs='[...]'`",
        `6. \`${controlTool} proposalId=1\``,
        "7. `dao_execute proposalId=1`",
      ]
    : ["3. `dao_deliberate proposalId=1`", `4. \`${controlTool} proposalId=1\``, "5. `dao_execute proposalId=1`"];

  const flow = [
    "# DAO Help",
    "",
    "Recommended flow:",
    "1. `dao_setup`",
    '2. `dao_propose title="..." type="product-feature" description="..."`',
    ...deliberationSteps,
  ];

  if (options.hideCatalogue) return flow.join("\n");

  const catalogue = buildDaoCommandHelp({ host: options.host, title: "Full command reference" });
  return `${flow.join("\n")}\n\n${catalogue}`;
}
