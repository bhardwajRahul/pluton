import { Task } from './AbstractTask';
import { cronLogger } from '../../utils/logger';
import { Job } from '../JobQueue';
import { SELF_BACKUP_JOB_NAME } from '../systemJobs';
import { SelfBackupService } from '../../services/SelfBackupService';

/**
 * Ticks hourly and gates on `intervalHours` from settings.
 */
export class SelfBackupTask extends Task {
	name = SELF_BACKUP_JOB_NAME;

	constructor(private selfBackupService: SelfBackupService) {
		super();
	}

	async run(job?: Job): Promise<void> {
		const force = job?.payload?.force === true;

		if (!force && !(await this.selfBackupService.isDue())) {
			return;
		}

		const result = await this.selfBackupService.run({ force });
		cronLogger.info(`[SelfBackup] Run finished with status: ${result.status}`);
	}
}
