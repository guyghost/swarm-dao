export const DAO_ONBOARDING_MESSAGE = [
  "# DAO not initialized",
  "",
  "1. Run `dao_setup` to create the default governance agents.",
  "2. Run `dao_help` to see the full workflow and available tools.",
  '3. Start your first proposal with `dao_propose title="..." type="product-feature" description="..."`.',
].join("\n");

export function buildDaoHelpMessage(options: { manualDeliberation: boolean; controlTool: string }): string {
  const deliberationSteps = options.manualDeliberation
    ? [
        "3. `dao_deliberate proposalId=1`",
        "4. Spawn sub-agents via your host's task/agent tool using the dispatch plan",
        "5. `dao_record_outputs proposalId=1 outputs='[...]'`",
        `6. \`${options.controlTool} proposalId=1\``,
        "7. `dao_execute proposalId=1`",
      ]
    : [
        "3. `dao_deliberate proposalId=1`",
        `4. \`${options.controlTool} proposalId=1\``,
        "5. `dao_execute proposalId=1`",
      ];

  return [
    "# DAO Help",
    "",
    "Recommended flow:",
    "1. `dao_setup`",
    '2. `dao_propose title="..." type="product-feature" description="..."`',
    ...deliberationSteps,
    "",
    "Discovery tools:",
    "- `dao_list` — proposals overview",
    "- `dao_agents` — configured agents",
    "- `dao_dashboard` — governance health summary",
    "- `dao_audit` — audit trail",
  ].join("\n");
}
