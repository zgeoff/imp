import * as z from 'zod';

// One segment of a read-only file's path. No segment starts with a dot, so
// no path names a file the agent stages. The agent checks the same rule
// (agent/internal/files).
export const FILE_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// the most bytes one read-only file holds, as the agent caps them
export const FILE_DATA_MAX_BYTES = 524_288;

// where the read-only files show in the guest
export const FILES_GUEST_DIR = '/run/imp/files';
const FILE_PATH_MAX_SEGMENTS = 8;
const FILE_PATH_MAX_LENGTH = 512;

// a read-only file's path under FILES_GUEST_DIR
// (docs/architecture/guest/agent.md#read-only-files)
export const FilePathSchema = z
  .string()
  .min(1)
  .max(FILE_PATH_MAX_LENGTH)
  .refine(
    (path) => {
      const segments = path.split('/');

      return (
        segments.length <= FILE_PATH_MAX_SEGMENTS &&
        segments.every((segment) => FILE_SEGMENT_PATTERN.test(segment))
      );
    },
    {
      message: `must be 1 to ${FILE_PATH_MAX_SEGMENTS} segments joined by /, each a letter, digit or _ followed by up to 127 letters, digits, ., _ or -`,
    },
  );

// a read-only file's content, as UTF-8 text within the agent's cap
export const FileContentSchema = z
  .string()
  .refine((content) => new TextEncoder().encode(content).byteLength <= FILE_DATA_MAX_BYTES, {
    message: `must be at most ${FILE_DATA_MAX_BYTES} bytes as UTF-8`,
  });
