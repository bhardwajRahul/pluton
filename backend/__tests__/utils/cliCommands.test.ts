import { isCliCommandInvocation, CLI_COMMAND_FLAGS } from '../../src/utils/cliCommands';

describe('isCliCommandInvocation', () => {
	it('detects every flag it claims to cover', () => {
		for (const flag of CLI_COMMAND_FLAGS) {
			expect(isCliCommandInvocation(['node', 'pluton', flag])).toBe(true);
		}
	});

	it('detects a flag that has arguments after it', () => {
		expect(isCliCommandInvocation(['node', 'pluton', '--restore-pluton', './b.pluton', '--force'])).toBe(
			true
		);
	});

	it('is false for a plain server start', () => {
		expect(isCliCommandInvocation(['node', 'pluton'])).toBe(false);
	});

	it('is false for unrelated flags, so a real boot still fail-fasts', () => {
		expect(isCliCommandInvocation(['node', 'pluton', '--verbose', '--port', '5173'])).toBe(false);
	});

	it('does not match a flag appearing as a value', () => {
		// Substring matching here would wrongly disarm the server's credential fail-fast.
		expect(isCliCommandInvocation(['node', 'pluton', '--title', 'my--restore-pluton-app'])).toBe(
			false
		);
	});

	it('covers the flags index.ts actually dispatches on', () => {
		// If these drift, ConfigService lets a command through that index.ts ignores, or vice
		// versa: the command exits 1 at import with a confusing credentials error.
		expect([...CLI_COMMAND_FLAGS]).toEqual(['--reset-password', '--restore-pluton']);
	});
});
