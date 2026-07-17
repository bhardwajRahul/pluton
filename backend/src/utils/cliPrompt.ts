import readline from 'readline';
import { Writable } from 'stream';

/**
 * Prompts the user for input via stdin.
 * When `hidden` is true, input is not echoed (for passwords).
 *
 * Shared by the CLI entry points, because copy-pasting raw-mode readline is how they drift.
 */
export function prompt(question: string, hidden = false): Promise<string> {
	return new Promise(resolve => {
		if (hidden) {
			// For hidden input, write the question directly and use raw mode
			process.stdout.write(question);
			const rl = readline.createInterface({
				input: process.stdin,
				output: new Writable({
					write(_chunk: any, _encoding: any, callback: () => void) {
						callback(); // swallow all output (hides typed characters)
					},
				}),
				terminal: true,
			});

			rl.question('', answer => {
				rl.close();
				process.stdout.write('\n');
				resolve(answer);
			});
		} else {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			rl.question(question, answer => {
				rl.close();
				resolve(answer);
			});
		}
	});
}
