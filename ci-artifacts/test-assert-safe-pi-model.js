function assertSafePiModel(model) {
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`Invalid pi model identifier: ${JSON.stringify(model)}`);
  }
  if (model.includes("\0")) {
    throw new Error("Invalid pi model identifier: null bytes are not allowed");
  }
  if (model.startsWith("-")) {
    throw new Error(`Invalid pi model identifier: ${JSON.stringify(model)} (must not start with '-')`);
  }
  if (/[;&|$`<>]/.test(model)) {
    throw new Error(`Invalid pi model identifier: ${JSON.stringify(model)}`);
  }
}

function expectThrows(fn, description) {
  try {
    fn();
  } catch (e) {
    console.log('THREW as expected:', description, '-', e.message);
    return;
  }
  console.error('EXPECTED TO THROW but did not:', description);
  process.exitCode = 2;
  throw new Error('Test failed');
}

function expectNotThrows(fn, description) {
  try {
    fn();
  } catch (e) {
    console.error('EXPECTED NOT TO THROW but threw:', description, '-', e.message);
    process.exitCode = 2;
    throw e;
  }
  console.log('DID NOT THROW as expected:', description);
}

expectThrows(() => assertSafePiModel('--help'), "leading dash");
expectThrows(() => assertSafePiModel('model;rm -rf /'), "semicolon injection");
expectNotThrows(() => assertSafePiModel('anthropic/claude-3.5-sonnet'), "valid provider id");
console.log('All local assertion checks passed.');
