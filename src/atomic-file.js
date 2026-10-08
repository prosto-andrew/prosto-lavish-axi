import { rename, rm, writeFile } from "node:fs/promises";

// Windows refuses to replace a file that any process holds open - a plain reader of the same file
// included - with EPERM, and a freshly written temporary file that a scanner is still reading with
// EBUSY. Such holds usually clear within milliseconds, so the replace is retried - 10, 20, 40 and
// 80 ms apart, then every 100 ms, about 2 s in all - and then fails with the error that blocked it.
// Elsewhere those codes are real permission errors and are never retried.
export const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, ...Array(18).fill(100)];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

let temporaryFileId = 0;

/**
 * Replace `file` so a reader sees either its previous or its new contents, never a mix, and a
 * crash mid-write leaves the previous file whole. The temporary name `<file>.<pid>.<n>.tmp` sits
 * in the same directory, so the rename never crosses a volume.
 *
 * @param {string} file
 * @param {string | Uint8Array} content
 * @param {{ mode?: number, flush?: boolean, platform?: string, delaysMs?: number[], renameFile?: typeof rename }} [options]
 */
export async function writeFileAtomically(
  file,
  content,
  { mode, flush = false, platform = process.platform, delaysMs = RENAME_RETRY_DELAYS_MS, renameFile = rename } = {},
) {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flush });
    await renameReplacing(temporary, file, { platform, delaysMs, renameFile });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Rename `from` over `to`, retrying on Windows while another handle blocks it.
 *
 * @param {string} from
 * @param {string} to
 * @param {{ platform?: string, delaysMs?: number[], renameFile?: typeof rename }} [options]
 */
export async function renameReplacing(
  from,
  to,
  { platform = process.platform, delaysMs = RENAME_RETRY_DELAYS_MS, renameFile = rename } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      const retryable = platform === "win32" && RETRYABLE_RENAME_CODES.has(error?.code);
      if (!retryable || attempt >= delaysMs.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }
}
