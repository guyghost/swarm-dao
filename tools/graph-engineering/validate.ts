import { validateGraphContract } from "./contract.js";

const result = await validateGraphContract(process.cwd());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) process.exitCode = 1;
