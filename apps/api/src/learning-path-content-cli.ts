import { loadConfig } from './config.js';
import { importLearningPaths, loadAndValidateLearningPathsContent } from './learning-path-content.js';
import { closeDependencies, connectDependencies, createDependencies } from './services.js';

const command = process.argv[2] ?? 'validate';

if (command === 'validate') {
  const { report } = await loadAndValidateLearningPathsContent();
  console.log(JSON.stringify(report, null, 2));
} else if (command === 'import') {
  const dependencies = createDependencies(loadConfig());
  try {
    await connectDependencies(dependencies);
    const report = await importLearningPaths(dependencies.postgres);
    console.log(JSON.stringify({ imported: report.items, ...report }, null, 2));
  } finally {
    await closeDependencies(dependencies);
  }
} else {
  throw new Error(`Unknown command "${command}". Use validate or import.`);
}
