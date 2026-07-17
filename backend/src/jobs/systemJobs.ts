import { SystemJobConfig } from '../types/global';

export const SELF_BACKUP_JOB_NAME = 'SelfBackup';

export const SYSTEM_JOBS: SystemJobConfig[] = [
	{
		name: 'CleanDownloads',
		schedule: '0 2 * * *', // Every day at 2:00 AM
		maxAttempts: 2,
		retryDelay: 300000,
	},
	{
		name: SELF_BACKUP_JOB_NAME,
		schedule: '0 * * * *',
		maxAttempts: 3,
		retryDelay: 600000,
	},
	// {
	// 	name: 'PruneDatabase',
	// 	schedule: '0 3 * * *', // Every day at 3:00 AM
	// 	maxAttempts: 5,
	// },
	// {
	// 	name: 'UpdateDevices',
	// 	schedule: '0 4 * * *', // Every day at 4:00 AM
	// 	maxAttempts: 2,
	// 	retryDelay: 600000,
	// },
	// Add other system jobs here
];

export const CORE_SYSTEM_JOBS = SYSTEM_JOBS;
