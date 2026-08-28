import type { ChallengeChecker, ChallengeCheckerContract } from './checker-contract.js';

export const CHECKER_FILE_LIMIT_BYTES = 64 * 1024;
export const CHECKER_OUTPUT_LIMIT_BYTES = 16 * 1024;
export const CHECKER_COMMAND_TIMEOUT_MS = 1_500;
export const CHECKER_OVERALL_TIMEOUT_MS = 8_000;

export interface CheckerExecOptions { timeoutMs: number; maxOutputBytes: number }
export interface CheckerExecResult { exitCode: number; output: string; truncated: boolean }
export type CheckerExecutor = (argv: readonly string[], options: CheckerExecOptions) => Promise<CheckerExecResult>;

export interface CheckerResult {
  id: string;
  type: ChallengeChecker['type'];
  status: 'passed' | 'failed' | 'error';
  code: string;
  failureHint?: string;
}

export interface CheckerEvaluation {
  outcome: 'passed' | 'failed' | 'error';
  results: CheckerResult[];
  durationMs: number;
}

export class CheckerService {
  async evaluate(contract: ChallengeCheckerContract, executor: CheckerExecutor): Promise<CheckerEvaluation> {
    const startedAt = performance.now();
    const deadline = startedAt + CHECKER_OVERALL_TIMEOUT_MS;
    const results: CheckerResult[] = [];
    for (const checker of contract.checks) {
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) {
        results.push(errorResult(checker, 'overall_timeout'));
        break;
      }
      try {
        results.push(await this.run(checker, executor, Math.min(CHECKER_COMMAND_TIMEOUT_MS, remainingMs)));
      } catch {
        results.push(errorResult(checker, 'execution_error'));
      }
    }
    const durationMs = Math.round(performance.now() - startedAt);
    const outcome = results.some((result) => result.status === 'error')
      ? 'error'
      : results.length === contract.checks.length && results.every((result) => result.status === 'passed')
        ? 'passed'
        : 'failed';
    return { outcome, results, durationMs };
  }

  private async run(checker: ChallengeChecker, executor: CheckerExecutor, timeoutMs: number): Promise<CheckerResult> {
    const exec = (argv: readonly string[]) => executor(argv, { timeoutMs, maxOutputBytes: CHECKER_OUTPUT_LIMIT_BYTES });
    switch (checker.type) {
      case 'file_exists': {
        const flag = checker.kind === 'file' ? '-f' : checker.kind === 'directory' ? '-d' : '-e';
        return commandTruth(checker, await exec(['/usr/bin/test', flag, checker.path]), 'file_missing');
      }
      case 'file_not_exists':
        return commandTruth(checker, await exec(['/usr/bin/test', '!', '-e', checker.path]), 'file_exists');
      case 'file_contains': {
        const size = await exec(['/usr/bin/stat', '-c', '%s', '--', checker.path]);
        if (size.exitCode === 1) return failedResult(checker, 'file_missing');
        if (size.exitCode !== 0 || size.truncated) return errorResult(checker, 'stat_error');
        const bytes = Number.parseInt(size.output.trim(), 10);
        if (!Number.isSafeInteger(bytes)) return errorResult(checker, 'stat_error');
        if (bytes > CHECKER_FILE_LIMIT_BYTES) return errorResult(checker, 'file_too_large');
        const content = await exec(['/usr/bin/head', '-c', String(CHECKER_FILE_LIMIT_BYTES), '--', checker.path]);
        if (content.exitCode !== 0 || content.truncated) return errorResult(checker, 'read_error');
        return content.output.includes(checker.expected) ? passedResult(checker) : failedResult(checker, 'content_mismatch');
      }
      case 'permission_equals': {
        const result = await exec(['/usr/bin/stat', '-c', '%a', '--', checker.path]);
        if (result.exitCode === 1) return failedResult(checker, 'path_missing');
        if (result.exitCode !== 0 || result.truncated) return errorResult(checker, 'stat_error');
        return result.output.trim().padStart(4, '0') === checker.mode ? passedResult(checker) : failedResult(checker, 'permission_mismatch');
      }
      case 'owner_equals': {
        const result = await exec(['/usr/bin/stat', '-c', '%U:%G', '--', checker.path]);
        if (result.exitCode === 1) return failedResult(checker, 'path_missing');
        if (result.exitCode !== 0 || result.truncated) return errorResult(checker, 'stat_error');
        const [user, group] = result.output.trim().split(':');
        return user === checker.user && (!checker.group || group === checker.group) ? passedResult(checker) : failedResult(checker, 'owner_mismatch');
      }
      case 'symlink_points_to': {
        const result = await exec(['/usr/bin/readlink', '-f', '--', checker.path]);
        if (result.exitCode === 1) return failedResult(checker, 'symlink_missing');
        if (result.exitCode !== 0 || result.truncated) return errorResult(checker, 'readlink_error');
        return result.output.trim() === checker.target ? passedResult(checker) : failedResult(checker, 'symlink_target_mismatch');
      }
      case 'user_exists':
        return commandTruth(checker, await exec(['/usr/bin/getent', 'passwd', checker.user]), 'user_missing');
      case 'group_exists':
        return commandTruth(checker, await exec(['/usr/bin/getent', 'group', checker.group]), 'group_missing');
      case 'user_in_group': {
        const result = await exec(['/usr/bin/id', '-nG', checker.user]);
        if (result.exitCode === 1) return failedResult(checker, 'user_missing');
        if (result.exitCode !== 0 || result.truncated) return errorResult(checker, 'identity_error');
        return result.output.trim().split(/\s+/).includes(checker.group) ? passedResult(checker) : failedResult(checker, 'group_membership_missing');
      }
      case 'process_running':
      case 'process_not_running': {
        const result = await exec(['/usr/bin/ps', '-C', checker.process, '-o', 'stat=']);
        if (result.exitCode > 1 || result.truncated) return errorResult(checker, 'process_inspection_error');
        const running = result.exitCode === 0 && result.output
          .split(/\s+/)
          .some((state) => state.length > 0 && !state.startsWith('Z'));
        const passed = checker.type === 'process_running' ? running : !running;
        return passed ? passedResult(checker) : failedResult(checker, running ? 'process_still_running' : 'process_not_running');
      }
      case 'port_listening': {
        const result = await exec(['/usr/bin/ss', '-H', checker.protocol === 'tcp' ? '-ltn' : '-lun']);
        if (result.exitCode !== 0 || result.truncated) return errorResult(checker, 'network_inspection_error');
        const listening = result.output.split('\n').some((line) => socketMatches(line, checker.port, checker.bindAddress));
        return listening ? passedResult(checker) : failedResult(checker, 'port_not_listening');
      }
      case 'package_installed': {
        const result = await exec(['/usr/bin/dpkg-query', '-W', '-f=${Status}', checker.package]);
        if (result.exitCode === 1) return failedResult(checker, 'package_missing');
        if (result.exitCode !== 0 || result.truncated) return errorResult(checker, 'package_inspection_error');
        return result.output.trim() === 'install ok installed' ? passedResult(checker) : failedResult(checker, 'package_missing');
      }
    }
  }
}

function socketMatches(line: string, port: number, bindAddress?: string): boolean {
  const columns = line.trim().split(/\s+/);
  const local = columns[3] ?? '';
  const match = local.match(/^(.+):(\d+)$/);
  if (!match || Number(match[2]) !== port) return false;
  if (!bindAddress) return true;
  return match[1]?.replace(/^\[|\]$/g, '') === bindAddress;
}

function commandTruth(checker: ChallengeChecker, result: CheckerExecResult, failureCode: string): CheckerResult {
  if (result.truncated) return errorResult(checker, 'inspection_output_too_large');
  if (result.exitCode === 0) return passedResult(checker);
  // getent uses 2 for a well-formed lookup whose key is absent.
  if (result.exitCode === 1 || result.exitCode === 2) return failedResult(checker, failureCode);
  return errorResult(checker, 'inspection_error');
}

function passedResult(checker: ChallengeChecker): CheckerResult {
  return { id: checker.id, type: checker.type, status: 'passed', code: 'ok' };
}

function failedResult(checker: ChallengeChecker, code: string): CheckerResult {
  return { id: checker.id, type: checker.type, status: 'failed', code, ...(checker.failureHint ? { failureHint: checker.failureHint } : {}) };
}

function errorResult(checker: ChallengeChecker, code: string): CheckerResult {
  return { id: checker.id, type: checker.type, status: 'error', code };
}
