import '../public/extension/storage.js';
import '../public/extension/local-agent-bridge.js';
import '../public/extension/dom-adapter.js';
import '../public/extension/session-controller.js';
import '../public/extension/popup.js';
import '../public/extension/options.js';
import '../tests/extension.test.js';

async function main() {
  const suite = globalThis.JarvisTestSuite;
  const summary = await suite.runAllAutomatedTests();
  console.log('=========================================================================');
  console.log(
    `JARVIS AUTO-PILOT AUTOMATED TEST SUITE: ${summary.passed}/${summary.total} PASSED (${summary.failed} FAILED)`
  );
  console.log('=========================================================================');
  for (const r of summary.results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${r.id} | ${r.category.padEnd(32)} | ${r.title}`);
    if (!r.passed) {
      console.error(`       Error: ${r.error}`);
    }
  }
  console.log('=========================================================================');
  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
