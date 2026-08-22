import { loadConfig } from './config.js';
import { importLinuxCoreQuestions, loadAndValidateLinuxCoreContent } from './learning-content.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';

const command = process.argv[2] ?? 'validate';

if (command === 'validate') {
  const { report } = await loadAndValidateLinuxCoreContent();
  console.log(JSON.stringify(report, null, 2));
} else if (command === 'import') {
  const dependencies = createDependencies(loadConfig());
  try {
    await connectDependencies(dependencies);
    const report = await importLinuxCoreQuestions(dependencies.postgres);
    console.log(JSON.stringify({ imported: report.total, ...report }, null, 2));
  } finally {
    await closeDependencies(dependencies);
  }
} else {
  throw new Error(`Unknown command "${command}". Use validate or import.`);
}
