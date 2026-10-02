import { CHECKPOINT_TOOLS } from './checkpoint-tools';
import type { Tool } from './define-tool';
import { EXEC_TOOL } from './exec-tool';
import { FILE_TOOLS } from './file-tools';
import { IMP_TOOLS } from './imp-tools';

// in the order tools/list shows them
export const TOOLS: readonly Tool[] = [...IMP_TOOLS, EXEC_TOOL, ...FILE_TOOLS, ...CHECKPOINT_TOOLS];
