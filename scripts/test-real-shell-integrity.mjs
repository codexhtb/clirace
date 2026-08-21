const modulePath = process.env.CLIRACE_INTEGRITY_MODULE ?? '../apps/api/dist/sandbox-integrity.js';
const { runRealShellIntegrity } = await import(modulePath);

const result = await runRealShellIntegrity({
  socketPath: process.env.SANDBOX_DOCKER_SOCKET ?? '/run/clirace-sandbox/docker.sock',
  image: process.env.SANDBOX_IMAGE ?? 'clirace-sandbox:0.2.0',
  concurrency: Number(process.env.SANDBOX_INTEGRITY_CONCURRENCY ?? 4),
});

console.log(JSON.stringify(result, null, 2));
if (result.failed.length > 0) process.exitCode = 1;
