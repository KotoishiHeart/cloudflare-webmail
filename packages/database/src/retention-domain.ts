export type RetentionPolicy = {
  mailboxId: string;
  retentionDays: number;
  excludeStarred: boolean;
  excludeLabeled: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type RetentionRunStatus =
  | 'building'
  | 'preview'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RetentionRun = {
  id: string;
  mailboxId: string;
  status: RetentionRunStatus;
  cutoffAt: number;
  retentionDays: number;
  excludeStarred: boolean;
  excludeLabeled: boolean;
  candidateCount: number;
  candidateBytes: number;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
  backupReference: string;
  backupManifestSha256: string;
  backupCreatedAt: number | null;
  errorSummary: string;
  createdAt: number;
  approvedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
};

export type RetentionRunItem = {
  runId: string;
  messageId: string;
  status: 'candidate' | 'd1_deleted' | 'completed' | 'skipped' | 'failed';
  subjectSnapshot: string;
  receivedAt: number;
  deletedAt: number;
  bytes: number;
  objectKeys: string[];
  nextObjectIndex: number;
  attempts: number;
  d1DeletedAt: number | null;
  errorSummary: string;
  createdAt: number;
  updatedAt: number;
};
