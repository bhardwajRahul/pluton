import path from 'path';
import fs from 'fs';

/**
 * Resolve the drizzle migrations folder for the current runtime.
 * Docker ships them at a fixed path; binaries carry them beside the executable.
 */
export function getMigrationsFolder(): string {
	return process.env.IS_DOCKER === 'true'
		? '/app/drizzle'
		: path.join(path.dirname(process.execPath), 'drizzle');
}

export function getMigrationsJournalPath(migrationsFolder = getMigrationsFolder()): string {
	return path.join(migrationsFolder, 'meta', '_journal.json');
}

/**
 * The tag of the most recent applied migration, e.g. `0042_lively_thing`.
 * Returns null when no journal is present (dev runs, or a build without migrations).
 */
export function getDrizzleJournalTag(): string | null {
	try {
		const journalPath = getMigrationsJournalPath();
		if (!fs.existsSync(journalPath)) {
			return null;
		}
		const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
			entries?: { tag?: string }[];
		};
		const entries = journal.entries;
		if (!Array.isArray(entries) || entries.length === 0) {
			return null;
		}
		return entries[entries.length - 1]?.tag ?? null;
	} catch {
		return null;
	}
}
