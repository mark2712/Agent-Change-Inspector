import * as path from 'path';
import * as fs from 'fs';
import * as Diff from 'diff';
import { DiffHunkRange, FileChangeStatus } from './types';

// Расширения заведомо бинарных файлов
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svgz',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.bin', '.so', '.dylib', '.obj',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mov', '.mp3', '.wav', '.avi', '.mkv',
  '.iso', '.dmg', '.sqlite', '.db'
]);

/**
 * Проверка файла на бинарность по расширению и содержимому
 */
export function isBinaryFile(filePath: string, buffer?: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  try {
    const buf = buffer || (fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);
    if (!buf) {
      return false;
    }
    // Проверяем первые 1024 байта на наличие нулевого байта (признак бинарного файла)
    const checkLength = Math.min(buf.length, 1024);
    for (let i = 0; i < checkLength; i++) {
      if (buf[i] === 0) {
        return true;
      }
    }
  } catch {
    // В случае ошибки чтения считаем не бинарным
  }

  return false;
}

export interface DiffResult {
  hasChanges: boolean;
  status: FileChangeStatus;
  firstChangedLine?: number;
  addedLines: number;
  deletedLines: number;
  summaryText: string;
  hunks: DiffHunkRange[];
  isBinary?: boolean;
  isLarge?: boolean;
}

/**
 * Вычисляет независимый построчный diff между двумя строками (без вызова Git CLI)
 */
export function computeTextDiff(
  oldText: string | undefined | null,
  newText: string | undefined | null,
  filePath: string,
  maxSizeBytes = 2 * 1024 * 1024
): DiffResult {
  // 1. Проверка на удаление файла
  if (newText === undefined || newText === null) {
    const oldLines = oldText ? oldText.split(/\r?\n/).length : 0;
    return {
      hasChanges: true,
      status: 'deleted',
      firstChangedLine: 1,
      addedLines: 0,
      deletedLines: oldLines,
      summaryText: `Удален (-${oldLines})`,
      hunks: [],
    };
  }

  // 2. Проверка на новый файл (добавление)
  if (oldText === undefined || oldText === null) {
    const newLines = newText.split(/\r?\n/).length;
    return {
      hasChanges: true,
      status: 'added',
      firstChangedLine: 1,
      addedLines: newLines,
      deletedLines: 0,
      summaryText: `Новый (+${newLines})`,
      hunks: [
        {
          startLine: 1,
          endLine: Math.max(1, newLines),
          isAddition: true,
        },
      ],
    };
  }

  // 3. Если текст полностью совпадает — изменений нет
  if (oldText === newText) {
    return {
      hasChanges: false,
      status: 'modified',
      addedLines: 0,
      deletedLines: 0,
      summaryText: 'Без изменений',
      hunks: [],
    };
  }

  // 4. Проверка на слишком большой файл
  if (newText.length > maxSizeBytes || oldText.length > maxSizeBytes) {
    const sizeMb = (newText.length / (1024 * 1024)).toFixed(1);
    return {
      hasChanges: true,
      status: 'modified',
      addedLines: 0,
      deletedLines: 0,
      summaryText: `Большой файл (${sizeMb} МБ)`,
      hunks: [],
      isLarge: true,
    };
  }

  // 5. Построчный diff через библиотеку diff
  const changes = Diff.diffLines(oldText, newText);
  let totalAdded = 0;
  let totalDeleted = 0;
  let firstChangedLine: number | undefined;
  const hunks: DiffHunkRange[] = [];

  let currentLine = 1;

  for (const part of changes) {
    const count = part.count || 1;
    if (part.added) {
      if (firstChangedLine === undefined) {
        firstChangedLine = currentLine;
      }
      totalAdded += count;
      hunks.push({
        startLine: currentLine,
        endLine: currentLine + count - 1,
        isAddition: true,
      });
      currentLine += count;
    } else if (part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = currentLine;
      }
      totalDeleted += count;
      hunks.push({
        startLine: currentLine,
        endLine: currentLine,
        isAddition: false,
      });
    } else {
      currentLine += count;
    }
  }

  let summary = `+${totalAdded} -${totalDeleted}`;
  if (firstChangedLine !== undefined && totalAdded > 0) {
    summary += ` (стр. ${firstChangedLine})`;
  }

  return {
    hasChanges: totalAdded > 0 || totalDeleted > 0,
    status: 'modified',
    firstChangedLine: firstChangedLine ?? 1,
    addedLines: totalAdded,
    deletedLines: totalDeleted,
    summaryText: summary,
    hunks,
  };
}
