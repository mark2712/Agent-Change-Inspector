import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileChangeInfo, FileChangeStatus } from './types';
import { computeTextDiff, isBinaryFile } from './diffHelper';
import { StorageManager } from './storageManager';
import { IgnoreManager } from './ignoreManager';

interface BaselineEntry {
  content: string;
  size: number;
  mtime: number;
  isBinary: boolean;
}

/**
 * Менеджер исходного состояния (базовой линии) файлов проекта.
 * Позволяет точно и быстро вычислять diff без использования внешних git-команд.
 */
export class BaselineManager {
  private baseline = new Map<string, BaselineEntry>();
  private initialized = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly storageManager: StorageManager,
    private readonly ignoreManager: IgnoreManager,
    private readonly maxSizeBytes = 2 * 1024 * 1024
  ) {}

  /**
   * Инициализировать baseline: быстрое сканирование текстовых файлов проекта
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.baseline.clear();
    await this.scanDirectory(this.workspaceRoot);
    this.initialized = true;
    console.log(`[AgentInspector] Baseline инициализирован: ${this.baseline.size} файлов.`);
  }

  private async scanDirectory(dir: string, depth = 0): Promise<void> {
    if (depth > 20) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
      const normalized = ('/' + relPath + '/').toLowerCase();

      // Жестко отсекаем служебные каталоги еще на уровне обхода
      if (
        entry.isDirectory() &&
        (entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === '.agent-inspector' ||
          entry.name === '.vscode' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '.next' ||
          entry.name === 'tmp' ||
          normalized.includes('/.git/') ||
          normalized.includes('/node_modules/') ||
          normalized.includes('/.agent-inspector/'))
      ) {
        continue;
      }

      // Проверка через .agentignore
      if (this.ignoreManager.isIgnored(relPath + (entry.isDirectory() ? '/' : ''))) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath, depth + 1);
      } else if (entry.isFile()) {
        await this.recordBaselineFile(fullPath, relPath);
      }
    }
  }

  private async recordBaselineFile(fullPath: string, relPath: string): Promise<void> {
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.size > this.maxSizeBytes) {
        this.baseline.set(relPath, {
          content: '',
          size: stat.size,
          mtime: stat.mtimeMs,
          isBinary: false,
        });
        return;
      }

      if (isBinaryFile(fullPath)) {
        this.baseline.set(relPath, {
          content: '',
          size: stat.size,
          mtime: stat.mtimeMs,
          isBinary: true,
        });
        return;
      }

      const content = await fs.promises.readFile(fullPath, 'utf-8');
      this.baseline.set(relPath, {
        content,
        size: stat.size,
        mtime: stat.mtimeMs,
        isBinary: false,
      });
    } catch {
      // Игнорируем недоступные файлы
    }
  }

  /**
   * Проверить, известен ли файл в базовой линии
   */
  has(relPath: string): boolean {
    return this.baseline.has(relPath.replace(/\\/g, '/'));
  }

  /**
   * Получить baseline-содержимое файла
   */
  getBaselineContent(relPath: string): string | undefined {
    return this.baseline.get(relPath.replace(/\\/g, '/'))?.content;
  }

  /**
   * Вычислить изменение для одного файла и сохранить снимок при необходимости
   */
  async inspectFileChange(
    filePath: string,
    currentStepFolder: string,
    isProtected: boolean
  ): Promise<FileChangeInfo | null> {
    const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
    const base = this.baseline.get(relPath);
    const fileExists = fs.existsSync(filePath);

    let status: FileChangeStatus = 'modified';
    let newContent: string | null = null;
    let isBinary = false;
    let isLarge = false;

    if (!fileExists) {
      if (!base) {
        // Файла не было и сейчас нет — игнорируем
        return null;
      }
      // Файл был в baseline, но сейчас удален
      status = 'deleted';
    } else {
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > this.maxSizeBytes) {
          isLarge = true;
        } else if (isBinaryFile(filePath)) {
          isBinary = true;
        } else {
          newContent = await fs.promises.readFile(filePath, 'utf-8');
        }
      } catch {
        return null;
      }

      if (!base) {
        // Файла не было в baseline, но он создан
        status = 'added';
      } else {
        // Файл модифицирован
        status = 'modified';
      }
    }

    // Если файл бинарный
    if (isBinary) {
      let snapshotPath: string | undefined;
      if (base && (status === 'modified' || status === 'deleted')) {
        // Для бинарных файлов сохраняем снимок с диска если возможно
        snapshotPath = this.storageManager.getSnapshotFilePath(currentStepFolder, relPath);
      }

      return {
        uri: vscode.Uri.file(filePath),
        fsPath: filePath,
        relativeName: relPath,
        timestamp: Date.now(),
        status,
        changedLinesSummary: `[Бинарный файл: ${status}]`,
        firstChangedLine: 1,
        addedLines: 0,
        deletedLines: 0,
        isProtected,
        isUntracked: !base,
        isDeleted: status === 'deleted',
        isBinary: true,
        isLarge: false,
        hunks: [],
        snapshotPath,
      };
    }

    // Если файл большой (> maxSizeBytes)
    if (isLarge) {
      return {
        uri: vscode.Uri.file(filePath),
        fsPath: filePath,
        relativeName: relPath,
        timestamp: Date.now(),
        status,
        changedLinesSummary: `[Большой файл: ${status}]`,
        firstChangedLine: 1,
        addedLines: 0,
        deletedLines: 0,
        isProtected,
        isUntracked: !base,
        isDeleted: status === 'deleted',
        isBinary: false,
        isLarge: true,
        hunks: [],
      };
    }

    // Вычисляем текстовый diff
    const oldText = base ? base.content : null;
    const diff = computeTextDiff(oldText, newContent, filePath, this.maxSizeBytes);

    // Если изменений нет (например, пользователь нажал Ctrl+Z и вернул файл к baseline)
    if (!diff.hasChanges) {
      return null;
    }

    let snapshotPath: string | undefined;
    // Если файл был модифицирован или удален, гарантируем сохранение исходного снимка
    if (base && (diff.status === 'modified' || diff.status === 'deleted')) {
      snapshotPath = await this.storageManager.savePreChangeSnapshot(
        currentStepFolder,
        relPath,
        base.content
      );
    }

    return {
      uri: vscode.Uri.file(filePath),
      fsPath: filePath,
      relativeName: relPath,
      timestamp: Date.now(),
      status: diff.status,
      changedLinesSummary: diff.summaryText,
      firstChangedLine: diff.firstChangedLine,
      addedLines: diff.addedLines,
      deletedLines: diff.deletedLines,
      isProtected,
      isUntracked: !base,
      isDeleted: diff.status === 'deleted',
      isBinary: false,
      isLarge: false,
      hunks: diff.hunks,
      snapshotPath,
    };
  }

  /**
   * Обновить baseline после фиксации шага
   */
  async commitChanges(changes: FileChangeInfo[]): Promise<void> {
    for (const change of changes) {
      const relPath = change.relativeName.replace(/\\/g, '/');
      if (change.isDeleted) {
        this.baseline.delete(relPath);
      } else if (fs.existsSync(change.fsPath)) {
        await this.recordBaselineFile(change.fsPath, relPath);
      }
    }
  }

  /**
   * Откатить файлы к baseline
   */
  async revertChangesToBaseline(changes: FileChangeInfo[]): Promise<void> {
    for (const change of changes) {
      const relPath = change.relativeName.replace(/\\/g, '/');
      const base = this.baseline.get(relPath);

      if (!base) {
        // Файл был добавлен на текущем шаге — удаляем его
        if (fs.existsSync(change.fsPath)) {
          await fs.promises.unlink(change.fsPath).catch(() => {});
        }
      } else {
        // Восстанавливаем содержимое из baseline
        const targetDir = path.dirname(change.fsPath);
        if (!fs.existsSync(targetDir)) {
          await fs.promises.mkdir(targetDir, { recursive: true });
        }
        await fs.promises.writeFile(change.fsPath, base.content, 'utf-8');
      }
    }
  }
}
