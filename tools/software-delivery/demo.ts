import { createReferenceScenario } from "../../packages/software-delivery/src/testing/reference-scenario.js";

const main = async (): Promise<void> => {
  const validated = await createReferenceScenario({ riskClass: "standard" });
  let rolledBack: Awaited<ReturnType<typeof createReferenceScenario>> | null = null;
  try {
    const validatedResult = await validated.resumeUntilPauseOrTerminal();
    if (validatedResult.state !== "validated") {
      throw new Error(`standard reference run ended in ${validatedResult.state}`);
    }

    rolledBack = await createReferenceScenario({ riskClass: "standard", degradedObservations: true });
    const rollbackPause = await rolledBack.resumeUntilPauseOrTerminal();
    if (rollbackPause.state !== "observing" || !rolledBack.delivery.snapshot().context.rollbackConfirmed) {
      throw new Error(`degraded reference run did not confirm rollback (${rollbackPause.state})`);
    }
    if (!(await rolledBack.openCorrectiveTask())) {
      throw new Error("reference Product runner did not accept its corrective task signal");
    }
    const rollbackResult = await rolledBack.resumeUntilPauseOrTerminal();
    if (rollbackResult.state !== "rolledBack") {
      throw new Error(`rollback reference run ended in ${rollbackResult.state}`);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          demo: "repository-native software delivery",
          approvedModelHash: "ddfa68a40b41be3b5030fb6951d3604e27c5dbe43b46124d0fd5885a9ae31e8b",
          standardOutcome: validatedResult.state,
          degradedOutcome: rollbackResult.state,
          observations: "temporary local staging only",
          output: "no prompts or personal data",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await Promise.all([validated.cleanup(), ...(rolledBack ? [rolledBack.cleanup()] : [])]);
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
