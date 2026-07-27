import {
	ResticExitCode,
	classifyResticExitCode,
	isResticBackupWarning,
	isRetryableResticError,
	isNonRetryableResticError,
} from '../../../src/utils/restic/exitCodes';

describe('classifyResticExitCode', () => {
	it('classifies exit code 0 as success (not retryable, not a warning)', () => {
		const result = classifyResticExitCode(0);
		expect(result.category).toBe('success');
		expect(result.retryable).toBe(false);
		expect(result.isWarning).toBe(false);
	});

	it('classifies exit code 3 as a success-with-warning that must NOT be retried', () => {
		const result = classifyResticExitCode(ResticExitCode.IncompleteBackup);
		expect(result.category).toBe('warning');
		expect(result.retryable).toBe(false);
		expect(result.isWarning).toBe(true);
	});

	it('classifies exit code 11 (lock failed) as retryable', () => {
		const result = classifyResticExitCode(ResticExitCode.RepositoryLockFailed);
		expect(result.category).toBe('retryable');
		expect(result.retryable).toBe(true);
	});

	it('classifies exit code 12 (wrong password) as fatal / not retryable', () => {
		const result = classifyResticExitCode(ResticExitCode.WrongPassword);
		expect(result.category).toBe('fatal');
		expect(result.retryable).toBe(false);
	});

	it('classifies exit code 10 (repo does not exist) as fatal / not retryable', () => {
		const result = classifyResticExitCode(ResticExitCode.RepositoryDoesNotExist);
		expect(result.category).toBe('fatal');
		expect(result.retryable).toBe(false);
	});

	it('classifies generic error (1) and runtime error (2) as retryable', () => {
		expect(classifyResticExitCode(1).retryable).toBe(true);
		expect(classifyResticExitCode(2).retryable).toBe(true);
	});

	it('classifies interruption (130) as cancelled / not retryable', () => {
		const result = classifyResticExitCode(ResticExitCode.Interrupted);
		expect(result.category).toBe('cancelled');
		expect(result.retryable).toBe(false);
	});

	it('treats unknown or undefined codes as retryable by default', () => {
		expect(classifyResticExitCode(undefined).retryable).toBe(true);
		expect(classifyResticExitCode(999).retryable).toBe(true);
	});
});

describe('isResticBackupWarning', () => {
	it('returns true only for exit code 3', () => {
		expect(isResticBackupWarning(3)).toBe(true);
		expect(isResticBackupWarning(0)).toBe(false);
		expect(isResticBackupWarning(11)).toBe(false);
		expect(isResticBackupWarning(undefined)).toBe(false);
	});
});

describe('isRetryableResticError', () => {
	it('returns true for transient failures (1, 2, 11)', () => {
		expect(isRetryableResticError(1)).toBe(true);
		expect(isRetryableResticError(2)).toBe(true);
		expect(isRetryableResticError(11)).toBe(true);
	});

	it('returns false for permanent failures and warnings (3, 10, 12, 130)', () => {
		expect(isRetryableResticError(3)).toBe(false);
		expect(isRetryableResticError(10)).toBe(false);
		expect(isRetryableResticError(12)).toBe(false);
		expect(isRetryableResticError(130)).toBe(false);
	});
});

describe('isNonRetryableResticError', () => {
	it('is true only for genuine permanent failures', () => {
		expect(isNonRetryableResticError(12)).toBe(true);
		expect(isNonRetryableResticError(10)).toBe(true);
		expect(isNonRetryableResticError(130)).toBe(true);
	});

	it('is false for success, warning, retryable and unknown codes', () => {
		expect(isNonRetryableResticError(0)).toBe(false);
		expect(isNonRetryableResticError(3)).toBe(false); // warning is not a failure
		expect(isNonRetryableResticError(11)).toBe(false);
		expect(isNonRetryableResticError(1)).toBe(false);
		expect(isNonRetryableResticError(undefined)).toBe(false);
	});
});
