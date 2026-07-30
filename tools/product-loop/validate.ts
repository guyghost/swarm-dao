import { validateProductContract } from "./contract.js";

const root = process.cwd();

const result = await validateProductContract(root);
if (!result.valid) {
  for (const issue of result.issues) console.error(`✗ ${issue}`);
  console.error(`\nProduct-loop contract is INVALID (model hash ${result.modelHash}).`);
  process.exit(1);
}

console.log(`✓ Product-loop contract is frozen and matches the XState model.`);
console.log(`  model hash: ${result.modelHash}`);
