import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileChangeInfo, TurnCheckpoint } from './types';

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
 * Менеджер физического хранилища:
 * - .agent-inspector/tree (индексы изменений / дерево метаданных)
 * - .agent-inspector/snapshots (точные копии файлов ДО правок или удаленных файлов)
 */
export class StorageManager {
  private inspectorDir: string;
  private snapshotsDir: string;
  private treeDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.inspectorDir = path.join(workspaceRoot, '.agent-inspector');
    this.snapshotsDir = path.join(this.inspectorDir, 'snapshots');
    this.treeDir = path.join(this.inspectorDir, 'tree');
    this.ensureDirs();
  }

  private ensureDirs() {
    try {
      if (!fs.existsSync(this.inspectorDir)) {
        fs.mkdirSync(this.inspectorDir, { recursive: true });
      }

      // Защищаем весь .agent-inspector от случайного коммита в Git
      const gitignorePath = path.join(this.inspectorDir, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '*\n', 'utf-8');
      }

      if (!fs.existsSync(this.snapshotsDir)) {
        fs.mkdirSync(this.snapshotsDir, { recursive: true });
      }

      if (!fs.existsSync(this.treeDir)) {
        fs.mkdirSync(this.treeDir, { recursive: true });
      }
    } catch (err) {
      console.error('[AgentInspector] Ошибка инициализации папок хранилища:', err);
    }
  }

  getSnapshotsDir(): string {
    return this.snapshotsDir;
  }

  getTreeDir(): string {
    return this.treeDir;
  }

  /**
   * Получить путь к снимку файла в рамках указанной папки шага
   */
  getSnapshotFilePath(stepFolder: string, relativePath: string): string {
    return path.join(this.snapshotsDir, stepFolder, relativePath.replace(/\\/g, '/'));
  }

  /**
   * Сохранить снимок файла (исходное состояние ДО изменений шага)
   */
  async savePreChangeSnapshot(
    stepFolder: string,
    relativePath: string,
    content: string | Buffer
  ): Promise<string> {
    const targetPath = this.getSnapshotFilePath(stepFolder, relativePath);
    const targetDir = path.dirname(targetPath);

    // Если снимок для этого шага уже сохранен — не перезаписываем (держим самое первое состояние)
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }

    if (!fs.existsSync(targetDir)) {
      await fs.promises.mkdir(targetDir, { recursive: true });
    }

    await fs.promises.writeFile(targetPath, content);
    return targetPath;
  }

  /**
   * Сохранить текущее дерево изменений в .agent-inspector/tree/current.json
   */
  async saveCurrentTree(files: FileChangeInfo[], stepFolder: string): Promise<void> {
    try {
      const data = {
        stepFolder,
        timestamp: Date.now(),
        files: files.map((f) => ({
          relPath: f.relativeName,
          fsPath: f.fsPath,
          status: f.status,
          timestamp: f.timestamp,
          changedLinesSummary: f.changedLinesSummary,
          firstChangedLine: f.firstChangedLine,
          addedLines: f.addedLines,
          deletedLines: f.deletedLines,
          isProtected: f.isProtected,
          isUntracked: f.isUntracked,
          isDeleted: f.isDeleted,
          isBinary: f.isBinary,
          isLarge: f.isLarge,
          isUserSave: f.isUserSave,
          snapshotPath: f.snapshotPath,
          oldRelativeName: f.oldRelativeName,
          hunks: f.hunks,
        })),
      };

      const currentPath = path.join(this.treeDir, 'current.json');
      await fs.promises.writeFile(currentPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AgentInspector] Ошибка записи current.json:', err);
    }
  }

  /**
   * Зафиксировать текущий шаг: сохранить в .agent-inspector/tree/<folderName>.json и очистить current.json
   */
  async archiveStep(checkpoint: TurnCheckpoint): Promise<void> {
    try {
      const fileName = `${checkpoint.folderName}.json`;
      const targetPath = path.join(this.treeDir, fileName);

      const data = {
        id: checkpoint.id,
        stepNumber: checkpoint.stepNumber,
        title: checkpoint.title,
        folderName: checkpoint.folderName,
        timestamp: checkpoint.timestamp,
        files: checkpoint.files.map((f) => ({
          relPath: f.relativeName,
          fsPath: f.fsPath,
          status: f.status,
          timestamp: f.timestamp,
          changedLinesSummary: f.changedLinesSummary,
          firstChangedLine: f.firstChangedLine,
          addedLines: f.addedLines,
          deletedLines: f.deletedLines,
          isProtected: f.isProtected,
          isUntracked: f.isUntracked,
          isDeleted: f.isDeleted,
          isBinary: f.isBinary,
          isLarge: f.isLarge,
          isUserSave: f.isUserSave,
          snapshotPath: f.snapshotPath,
          oldRelativeName: f.oldRelativeName,
          hunks: f.hunks,
        })),
      };

      await fs.promises.writeFile(targetPath, JSON.stringify(data, null, 2), 'utf-8');

      // Очищаем current.json
      const currentPath = path.join(this.treeDir, 'current.json');
      if (fs.existsSync(currentPath)) {
        await fs.promises.unlink(currentPath).catch(() => {});
      }
    } catch (err) {
      console.error('[AgentInspector] Ошибка архивации дерева шага:', err);
    }
  }

  /**
   * Загрузить всю историю шагов из .agent-inspector/tree/*.json
   */
  async loadHistory(): Promise<TurnCheckpoint[]> {
    if (!fs.existsSync(this.treeDir)) {
      return [];
    }

    try {
      const entries = await fs.promises.readdir(this.treeDir);
      const checkpoints: TurnCheckpoint[] = [];

      for (const entry of entries) {
        if (!entry.endsWith('.json') || entry === 'current.json') {
          continue;
        }

        try {
          const filePath = path.join(this.treeDir, entry);
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const data = JSON.parse(raw);

          const files: FileChangeInfo[] = (data.files || []).map((f: any) => ({
            uri: vscode.Uri.file(f.fsPath || path.join(this.workspaceRoot, f.relPath)),
            fsPath: f.fsPath || path.join(this.workspaceRoot, f.relPath),
            relativeName: f.relPath,
            status: f.status || 'modified',
            timestamp: f.timestamp || data.timestamp,
            changedLinesSummary: f.changedLinesSummary || '',
            firstChangedLine: f.firstChangedLine,
            addedLines: f.addedLines || 0,
            deletedLines: f.deletedLines || 0,
            isProtected: !!f.isProtected,
            isUntracked: !!f.isUntracked,
            isDeleted: !!f.isDeleted,
            isBinary: !!f.isBinary,
            isLarge: !!f.isLarge,
            isUserSave: !!f.isUserSave,
            snapshotPath:
              f.snapshotPath || this.getSnapshotFilePath(data.folderName || data.id, f.relPath),
            oldRelativeName: f.oldRelativeName,
            hunks: f.hunks || [],
          }));

          checkpoints.push({
            id: data.id || path.basename(entry, '.json'),
            stepNumber: data.stepNumber || 1,
            title: data.title || `Шаг ${data.folderName}`,
            timestamp: data.timestamp || Date.now(),
            folderName: data.folderName || path.basename(entry, '.json'),
            files,
          });
        } catch (e) {
          console.error(`[AgentInspector] Ошибка чтения шага ${entry}:`, e);
        }
      }

      // Сортировка по времени (новые сначала)
      checkpoints.sort((a, b) => b.timestamp - a.timestamp);
      return checkpoints;
    } catch (err) {
      console.error('[AgentInspector] Ошибка загрузки истории шагов:', err);
      return [];
    }
  }

  /**
   * Восстановить отдельный файл из снимка шага
   */
  async restoreFileFromSnapshot(
    stepFolder: string,
    file: FileChangeInfo
  ): Promise<boolean> {
    try {
      // Если файл был создан на этом шаге (added) — откат означает его удаление
      if (file.status === 'added' || (file.isUntracked && !file.isDeleted)) {
        if (fs.existsSync(file.fsPath)) {
          await fs.promises.unlink(file.fsPath);
        }
        return true;
      }

      // Иначе восстанавливаем из снимка
      const snapshotFile =
        file.snapshotPath && fs.existsSync(file.snapshotPath)
          ? file.snapshotPath
          : this.getSnapshotFilePath(stepFolder, file.relativeName);

      if (fs.existsSync(snapshotFile)) {
        const targetDir = path.dirname(file.fsPath);
        if (!fs.existsSync(targetDir)) {
          await fs.promises.mkdir(targetDir, { recursive: true });
        }
        await fs.promises.copyFile(snapshotFile, file.fsPath);
        return true;
      } else {
        console.warn(`[AgentInspector] Снимок не найден для ${file.relativeName}: ${snapshotFile}`);
        return false;
      }
    } catch (err) {
      console.error(`[AgentInspector] Ошибка восстановления файла ${file.fsPath}:`, err);
      return false;
    }
  }

  /**
   * Восстановить все файлы шага
   */
  async restoreStep(checkpoint: TurnCheckpoint): Promise<boolean> {
    let allOk = true;
    for (const file of checkpoint.files) {
      const ok = await this.restoreFileFromSnapshot(checkpoint.folderName, file);
      if (!ok) {
        allOk = false;
      }
    }
    return allOk;
  }

  /**
   * Очистить историю архива
   */
  async clearAllHistory(): Promise<void> {
    try {
      // Удаляем все json-файлы в tree кроме current.json
      if (fs.existsSync(this.treeDir)) {
        const entries = await fs.promises.readdir(this.treeDir);
        for (const entry of entries) {
          if (entry !== 'current.json') {
            await fs.promises.unlink(path.join(this.treeDir, entry)).catch(() => {});
          }
        }
      }

      // Удаляем папки в snapshots
      if (fs.existsSync(this.snapshotsDir)) {
        const entries = await fs.promises.readdir(this.snapshotsDir);
        for (const entry of entries) {
          const fullPath = path.join(this.snapshotsDir, entry);
          await fs.promises.rm(fullPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[AgentInspector] Ошибка очистки архива:', err);
    }
  }
}
