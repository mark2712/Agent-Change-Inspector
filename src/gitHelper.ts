import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { DiffHunkRange } from './types';

const execAsync = promisify(exec);

// Расширения бинарных файлов, для которых diff не требуется
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svgz',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.bin', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mov', '.mp3', '.wav',
]);

/**
 * Результат анализа изменений через git diff
 */
export interface GitDiffSummary {
  hasChanges: boolean;
  isUntracked: boolean;
  isDeleted: boolean;
  firstChangedLine?: number;
  addedLines: number;
  deletedLines: number;
  summaryText: string;
  hunks: DiffHunkRange[];
}

/**
 * Проверить, отслеживается ли файл в Git
 */
export async function isTrackedInGit(filePath: string, workspaceRoot: string): Promise<boolean> {
  try {
    await execAsync(`git ls-files --error-unmatch -- "${filePath}"`, {
      cwd: workspaceRoot,
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Получить содержимое файла из Git HEAD (до изменений агента)
 */
export async function getFileFromGitHead(
  filePath: string,
  workspaceRoot: string
): Promise<Buffer | null> {
  try {
    const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
    const { stdout } = await execAsync(`git show "HEAD:${relPath}"`, {
      cwd: workspaceRoot,
      timeout: 3000,
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Получить сводку изменений и точные диапазоны строк через git diff -U0
 */
export async function getGitDiffSummary(
  filePath: string,
  workspaceRoot: string
): Promise<GitDiffSummary> {
  try {
    const fileExistsOnDisk = fs.existsSync(filePath);

    // 1. Защита от больших файлов (> 3 МБ)
    if (fileExistsOnDisk) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 3 * 1024 * 1024) {
          const sizeMb = (stat.size / (1024 * 1024)).toFixed(1);
          return {
            hasChanges: true,
            isUntracked: false,
            isDeleted: false,
            addedLines: 0,
            deletedLines: 0,
            summaryText: `Большой файл (${sizeMb} МБ)`,
            hunks: [],
          };
        }
      } catch {
        // Игнорируем ошибку stat
      }

      // 2. Защита от бинарных файлов по расширению
      const ext = path.extname(filePath).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        return {
          hasChanges: true,
          isUntracked: false,
          isDeleted: false,
          addedLines: 0,
          deletedLines: 0,
          summaryText: `Бинарный файл (${ext})`,
          hunks: [],
        };
      }
    }

    // 3. Проверяем статус в git porcelain с отключением подмодулей
    const { stdout: statusOut } = await execAsync(
      `git status --porcelain --ignore-submodules -- "${filePath}"`,
      {
        cwd: workspaceRoot,
        timeout: 2000,
      }
    );

    const statusTrim = (statusOut || '').trim();

    // Если файл удален
    const isDeleted =
      statusTrim.startsWith('D') ||
      statusTrim.includes(' D') ||
      (!fileExistsOnDisk && !statusTrim.startsWith('??'));

    if (isDeleted) {
      return {
        hasChanges: true,
        isUntracked: false,
        isDeleted: true,
        firstChangedLine: 1,
        addedLines: 0,
        deletedLines: 0,
        summaryText: 'Файл удален',
        hunks: [],
      };
    }

    // Если это новый неотслеживаемый файл (untracked)
    if (statusTrim.startsWith('??')) {
      let lineCount = 1;
      try {
        if (fileExistsOnDisk) {
          const content = fs.readFileSync(filePath, 'utf-8');
          lineCount = Math.max(1, content.split(/\r?\n/).length);
        }
      } catch {
        // Игнорируем
      }

      return {
        hasChanges: true,
        isUntracked: true,
        isDeleted: false,
        firstChangedLine: 1,
        addedLines: lineCount,
        deletedLines: 0,
        summaryText: 'Новый (untracked) файл',
        hunks: [
          {
            startLine: 1,
            endLine: lineCount,
            isAddition: true,
          },
        ],
      };
    }

    // 4. Выполняем git diff с нулевым контекстом и без подмодулей
    const { stdout } = await execAsync(
      `git diff -U0 --no-color --ignore-submodules -- "${filePath}"`,
      {
        cwd: workspaceRoot,
        timeout: 3000,
      }
    );

    if (!stdout || stdout.trim().length === 0) {
      if (statusTrim.length > 0) {
        return {
          hasChanges: true,
          isUntracked: false,
          isDeleted: false,
          firstChangedLine: 1,
          addedLines: 0,
          deletedLines: 0,
          summaryText: 'Изменен в Git',
          hunks: [],
        };
      }

      return {
        hasChanges: false,
        isUntracked: false,
        isDeleted: false,
        addedLines: 0,
        deletedLines: 0,
        summaryText: 'Без изменений в Git',
        hunks: [],
      };
    }

    // Регулярное выражение для парсинга заголовка hunk: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
    let match: RegExpExecArray | null;

    let firstChangedLine: number | undefined;
    let totalAdded = 0;
    let totalDeleted = 0;
    const lineRanges: string[] = [];
    const hunks: DiffHunkRange[] = [];

    while ((match = hunkRegex.exec(stdout)) !== null) {
      const oldStart = parseInt(match[1], 10);
      const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
      const newStart = parseInt(match[3], 10);
      const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

      if (firstChangedLine === undefined) {
        firstChangedLine = newCount > 0 ? newStart : Math.max(1, newStart);
      }

      totalAdded += newCount;
      totalDeleted += oldCount;

      if (newCount > 0) {
        const endLine = newStart + newCount - 1;
        lineRanges.push(newStart === endLine ? `стр. ${newStart}` : `стр. ${newStart}-${endLine}`);
        hunks.push({
          startLine: newStart,
          endLine,
          isAddition: true,
        });
      } else if (oldCount > 0) {
        lineRanges.push(`удалено возле стр. ${newStart}`);
        hunks.push({
          startLine: Math.max(1, newStart),
          endLine: Math.max(1, newStart),
          isAddition: false,
        });
      }
    }

    const rangesText = lineRanges.slice(0, 3).join(', ') + (lineRanges.length > 3 ? '...' : '');
    const summaryText = `${rangesText || 'изменения'} (+${totalAdded}/-${totalDeleted})`;

    return {
      hasChanges: true,
      isUntracked: false,
      isDeleted: false,
      firstChangedLine: firstChangedLine ?? 1,
      addedLines: totalAdded,
      deletedLines: totalDeleted,
      summaryText,
      hunks,
    };
  } catch (error) {
    const fileExists = fs.existsSync(filePath);
    return {
      hasChanges: true,
      isUntracked: !fileExists,
      isDeleted: !fileExists,
      firstChangedLine: 1,
      addedLines: 0,
      deletedLines: 0,
      summaryText: !fileExists ? 'Файл удален' : 'Изменен на диске',
      hunks: [],
    };
  }
}

/**
 * Откатить изменения в файле через git restore / checkout или удаление untracked
 */
export async function revertGitFile(filePath: string, workspaceRoot: string): Promise<boolean> {
  try {
    const tracked = await isTrackedInGit(filePath, workspaceRoot);
    if (!tracked) {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      return true;
    }

    try {
      await execAsync(`git restore -- "${filePath}"`, {
        cwd: workspaceRoot,
        timeout: 5000,
      });
      return true;
    } catch {
      await execAsync(`git checkout HEAD -- "${filePath}"`, {
        cwd: workspaceRoot,
        timeout: 5000,
      });
      return true;
    }
  } catch {
    return false;
  }
}
