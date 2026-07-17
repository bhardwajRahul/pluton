/**
 * The argv flags that make this process a short-lived CLI command rather than a server.
 *
 * Deliberately dependency-free: ConfigService imports this from its constructor, which runs
 * at module-eval time, so anything imported here would be pulled into every startup.
 */
export const CLI_COMMAND_FLAGS = ['--reset-password', '--restore-pluton'] as const;

/**
 * True when the process was invoked to run a CLI command and exit, not to serve.
 *
 * ConfigService fail-fasts on missing ENCRYPTION_KEY / USER_NAME / USER_PASSWORD to stop the
 * *app* booting into a broken state. A CLI command never boots the app: it does its work and
 * exits. Those credentials are the server's requirements, not the command's, and on the
 * deployments where a restore actually matters they are legitimately absent from the shell.
 */
export function isCliCommandInvocation(argv: string[] = process.argv): boolean {
	return CLI_COMMAND_FLAGS.some(flag => argv.includes(flag));
}
