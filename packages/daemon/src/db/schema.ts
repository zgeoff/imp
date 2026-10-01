import type { ImpState } from '@imp/api';

// Timestamps are integer milliseconds since the epoch.

interface ImagesTable {
  id: string;
  name: string;
  ref: string;
  digest: string;
  size_bytes: number;
  created_at: number;
}

interface ImpsTable {
  id: string;
  name: string;
  image_id: string;
  state: ImpState;
  vcpus: number;
  memory_mib: number;
  slot: number;
  ip: string;
  created_at: number;
  last_active_at: number;
  slept_at: number | null;
  hold_until: number | null;
  error: string | null;
  pid: number | null;
  firecracker_version: string | null;
}

interface CheckpointsTable {
  id: string;
  imp_id: string;
  label: string | null;
  created_at: number;
  size_bytes: number | null;
}

export interface DatabaseSchema {
  images: ImagesTable;
  imps: ImpsTable;
  checkpoints: CheckpointsTable;
}
