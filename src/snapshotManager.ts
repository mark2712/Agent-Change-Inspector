import * as path from 'path';
import * as fs from 'fs';
import { TurnCheckpoint } from './types';
import { revertGitFile } from './gitHelper';

/**
 * Менеджер снимков (снэпшотов) для безопасного пошагового отката промптов
 */
export class SnapshotManager {
  private baseDir: string | null = null;

  constructor(workspaceRoot?: string) {
    if (workspaceRoot) {
      this.baseDir = path.join(workspaceRoot, '.agent-inspector', 'snapshots');
      this.ensureBaseDir();
    }
  }

  private ensureBaseDir() {
    if (this.baseDir && !fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
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
    if (!this.baseDir || !fs.existsSync(fsPath)) {
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
      const turnDir = this.baseDir ? path.join(this.baseDir, checkpoint.id) : null;

      for (const file of checkpoint.files) {
        if (file.isUntracked && !file.isDeleted) {
          // Если файл был создан на этом шаге с нуля — удаляем его
          if (fs.existsSync(file.fsPath)) {
            await fs.promises.unlink(file.fsPath);
          }
          continue;
        }

        // Если есть сохраненный снимок — восстанавливаем из него
        if (turnDir) {
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
   * Удаление старых снимков, оставляем только последние N шагов
   */
  async cleanupOldSnapshots(activeTurnIds: string[]): Promise<void> {
    if (!this.baseDir || !fs.existsSync(this.baseDir)) {
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
