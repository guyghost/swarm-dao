// Anchor: audit-model-contract — validate the ship-audit graph contract and
// print the exact model hash.
import { validateShipAuditContract } from "./contract.js";

const root = process.cwd();
const result = await validateShipAuditContract(root);
console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exit(1);
