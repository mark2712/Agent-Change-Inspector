import * as path from 'path';
import * as fs from 'fs';
import { FileChangeInfo } from './types';
import { getFileFromGitHead, revertGitFile } from './gitHelper';

function padZero(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Форматирование даты в формат папки YYYY_MM_DD_HH_mm_ss
 */
export function formatArchiveTimestamp(d = new Date()): string {
  return `${d.getFullYear()}_${padZero(d.getMonth() + 1)}_${padZero(d.getDate())}_${padZero(
    d.getHours()
  )}_${padZero(d.getMinutes())}_${padZero(d.getSeconds())}`;
}

/**
 * Менеджер физического архива файлов в .agent-inspector/<timestamp>/...
 * Сохраняет точные копии файлов ДО правок агента, повторяя структуру папок проекта.
 */
export class ArchiveManager {
  private baseDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.baseDir = path.join(workspaceRoot, '.agent-inspector');
    this.ensureBaseDir();
  }

  private ensureBaseDir() {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
        // Защищаем архив от попадания в Git
        const gitignorePath = path.join(this.baseDir, '.gitignore');
        if (!fs.existsSync(gitignorePath)) {
          fs.writeFileSync(gitignorePath, '*\n', 'utf-8');
        }
      }
    } catch (err) {
      console.error('Ошибка создания директории архива .agent-inspector:', err);
    }
  }

  /**
   * Сохранить исходную копию файла (ДО правок) в папку шага
   */
  async archivePreChangeFile(folderName: string, change: FileChangeInfo): Promise<void> {
    // Не архивируем новые untracked файлы (их не существовало до этого шага)
    if (change.isUntracked && !change.isDeleted) {
      return;
    }

    try {
      const relPath = change.relativeName.replace(/\\/g, '/');
      const targetPath = path.join(this.baseDir, folderName, relPath);
      const targetDir = path.dirname(targetPath);

      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }

      // Если в рамках этого шага исходник уже сохранен — не перезаписываем
      if (fs.existsSync(targetPath)) {
        return;
      }

      // Получаем чистую версию файла из Git HEAD (до изменений агента)
      const headBuffer = await getFileFromGitHead(change.fsPath, this.workspaceRoot);

      if (headBuffer) {
        await fs.promises.writeFile(targetPath, headBuffer);
      } else if (fs.existsSync(change.fsPath)) {
        // Запасной вариант: прямое копирование с диска
        await fs.promises.copyFile(change.fsPath, targetPath);
      }
    } catch (err) {
      console.error(`Ошибка архивации файла ${change.fsPath}:`, err);
    }
  }

  /**
   * Восстановить файлы из архива шага
   */
  async restoreFromArchive(folderName: string, files: FileChangeInfo[]): Promise<boolean> {
    try {
      const stepDir = path.join(this.baseDir, folderName);

      for (const file of files) {
        if (file.isUntracked && !file.isDeleted) {
          if (fs.existsSync(file.fsPath)) {
            await fs.promises.unlink(file.fsPath);
          }
          continue;
        }

        const relPath = file.relativeName.replace(/\\/g, '/');
        const archiveFile = path.join(stepDir, relPath);

        if (fs.existsSync(archiveFile)) {
          const targetDir = path.dirname(file.fsPath);
          if (!fs.existsSync(targetDir)) {
            await fs.promises.mkdir(targetDir, { recursive: true });
          }
          await fs.promises.copyFile(archiveFile, file.fsPath);
        } else {
          // Если копии нет — восстанавливаем через Git
          await revertGitFile(file.fsPath, this.workspaceRoot);
        }
      }

      return true;
    } catch (err) {
      console.error(`Ошибка восстановления из архива ${folderName}:`, err);
      return false;
    }
  }

  /**
   * Очистить старые папки архива (оставляем последние N шагов)
   */
  async cleanupOldFolders(activeFolderNames: string[]): Promise<void> {
    if (!fs.existsSync(this.baseDir)) {
      return;
    }

    try {
      const entries = await fs.promises.readdir(this.baseDir);
      for (const entry of entries) {
        if (entry === '.gitignore' || activeFolderNames.includes(entry)) {
          continue;
        }
        const fullPath = path.join(this.baseDir, entry);
        const stat = await fs.promises.stat(fullPath);
        if (stat.isDirectory()) {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
        }
      }
    } catch {
      // Игнорируем ошибки очистки
    }
  }
}
