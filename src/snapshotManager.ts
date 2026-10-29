import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TurnCheckpoint } from './types';
import { revertGitFile } from './gitHelper';

/**
 * Менеджер снимков (снэпшотов) для безопасного пошагового отката промптов
 * Снимки хранятся во внешнем хранилище VS Code (storageUri) или временной папке ОС,
 * полностью исключая загрязнение рабочей области и зацикливание наблюдателя.
 */
export class SnapshotManager {
  private baseDir: string;

  constructor(storageDir?: string, workspaceRoot?: string) {
    if (storageDir) {
      this.baseDir = path.join(storageDir, 'agent-snapshots');
    } else if (workspaceRoot) {
      const safeWorkspaceName = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, '_');
      this.baseDir = path.join(os.tmpdir(), 'agent-inspector-snapshots', safeWorkspaceName);
    } else {
      this.baseDir = path.join(os.tmpdir(), 'agent-inspector-snapshots', 'default');
    }
    this.ensureBaseDir();
  }

  private ensureBaseDir() {
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
    } catch (err) {
      console.error('Ошибка создания директории снимков:', err);
    }
  }

  /**
   * Сохранить резервную копию файла перед правкой шага
   */
  async saveFileSnapshot(
    turnId: string,
    fsPath: string,
    workspaceRoot: string
  ): Promise<void> {
    if (!fs.existsSync(fsPath)) {
      return;
    }

    try {
      const relPath = path.relative(workspaceRoot, fsPath);
      const targetPath = path.join(this.baseDir, turnId, relPath);
      const targetDir = path.dirname(targetPath);

      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }

      // Сохраняем только первое состояние файла в рамках данного шага
      if (!fs.existsSync(targetPath)) {
        await fs.promises.copyFile(fsPath, targetPath);
      }
    } catch (err) {
      console.error(`Ошибка создания снимка файла ${fsPath}:`, err);
    }
  }

  /**
   * Восстановить состояние проекта до начала указанного шага
   */
  async restoreTurn(checkpoint: TurnCheckpoint, workspaceRoot: string): Promise<boolean> {
    try {
      const turnDir = path.join(this.baseDir, checkpoint.id);

      for (const file of checkpoint.files) {
        if (file.isUntracked && !file.isDeleted) {
          // Если файл был создан на этом шаге с нуля — удаляем его
          if (fs.existsSync(file.fsPath)) {
            await fs.promises.unlink(file.fsPath);
          }
          continue;
        }

        // Если есть сохраненный снимок — восстанавливаем из него
        const relPath = path.relative(workspaceRoot, file.fsPath);
        const snapFile = path.join(turnDir, relPath);

        if (fs.existsSync(snapFile)) {
          const targetDir = path.dirname(file.fsPath);
          if (!fs.existsSync(targetDir)) {
            await fs.promises.mkdir(targetDir, { recursive: true });
          }
          await fs.promises.copyFile(snapFile, file.fsPath);
          continue;
        }

        // Иначе восстанавливаем через Git
        await revertGitFile(file.fsPath, workspaceRoot);
      }

      return true;
    } catch (err) {
      console.error(`Ошибка отката шага ${checkpoint.id}:`, err);
      return false;
    }
  }

  /**
   * Удаление старых снимков, оставляем только активные шаги
   */
  async cleanupOldSnapshots(activeTurnIds: string[]): Promise<void> {
    if (!fs.existsSync(this.baseDir)) {
      return;
    }

    try {
      const entries = await fs.promises.readdir(this.baseDir);
      for (const entry of entries) {
        if (!activeTurnIds.includes(entry)) {
          const fullPath = path.join(this.baseDir, entry);
          await fs.promises.rm(fullPath, { recursive: true, force: true });
        }
      }
    } catch {
      // Игнорируем ошибки очистки
    }
  }
}
