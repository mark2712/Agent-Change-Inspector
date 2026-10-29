import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

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
 * Получить сводку изменений для конкретного файла через git diff -U0
 */
export async function getGitDiffSummary(
  filePath: string,
  workspaceRoot: string
): Promise<GitDiffSummary> {
  try {
    const fileExistsOnDisk = fs.existsSync(filePath);

    // 1. Проверяем статус в git porcelain с отключением подмодулей для максимальной скорости
    const { stdout: statusOut } = await execAsync(
      `git status --porcelain --ignore-submodules -- "${filePath}"`,
      {
        cwd: workspaceRoot,
        timeout: 2000,
      }
    );

    const statusTrim = (statusOut || '').trim();

    // Если файл удален (статус 'D' или ' D' или физически отсутствует на диске)
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
      };
    }

    // Если это новый неотслеживаемый файл (untracked)
    if (statusTrim.startsWith('??')) {
      return {
        hasChanges: true,
        isUntracked: true,
        isDeleted: false,
        firstChangedLine: 1,
        addedLines: 0,
        deletedLines: 0,
        summaryText: 'Новый (untracked) файл',
      };
    }

    // 2. Выполняем git diff с нулевым контекстом и без подмодулей
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
        };
      }

      return {
        hasChanges: false,
        isUntracked: false,
        isDeleted: false,
        addedLines: 0,
        deletedLines: 0,
        summaryText: 'Без изменений в Git',
      };
    }

    // Регулярное выражение для парсинга заголовка hunk: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
    let match: RegExpExecArray | null;

    let firstChangedLine: number | undefined;
    let totalAdded = 0;
    let totalDeleted = 0;
    const lineRanges: string[] = [];

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
      } else if (oldCount > 0) {
        lineRanges.push(`удалено возле стр. ${newStart}`);
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
      // Если файл новый и не отслеживается — удаляем его с диска
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      return true;
    }

    // Если файл отслеживается (включая удаленный) — восстанавливаем его из Git
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
