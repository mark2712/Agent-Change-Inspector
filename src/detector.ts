import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionConfig, FileChangeInfo } from './types';
import { getGitDiffSummary } from './gitHelper';
import { IgnoreManager } from './ignoreManager';

/**
 * Проверка совпадения пути с глоб-шаблонами
 */
function matchesPattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  for (const pattern of patterns) {
    const cleanPattern = pattern.replace(/\\/g, '/').toLowerCase();

    if (cleanPattern.startsWith('**/')) {
      const sub = cleanPattern.slice(3).replace(/\/\*\*$/, '');
      if (normalized.includes(sub)) {
        return true;
      }
    } else if (cleanPattern.endsWith('/**')) {
      const sub = cleanPattern.slice(0, -3);
      if (normalized.includes(sub)) {
        return true;
      }
    } else if (cleanPattern.includes('*')) {
      const regexStr = cleanPattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
      try {
        const regex = new RegExp(regexStr);
        if (regex.test(normalized)) {
          return true;
        }
      } catch {
        // Пропускаем некорректный regex
      }
    } else if (normalized.includes(cleanPattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Детектор внешних изменений файлов с защитой от рекурсивных циклов и лавинных событий
 */
export class ChangeDetector implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private userSaveTimes = new Map<string, number>();
  private pendingChanges = new Map<string, vscode.Uri>();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getConfig: () => ExtensionConfig,
    private readonly ignoreManager: IgnoreManager,
    private readonly isFileTracked: (fsPath: string) => boolean,
    private readonly onBatchProcessed: (changed: FileChangeInfo[], revertedPaths: string[]) => void
  ) {
    this.registerListeners();
  }

  private registerListeners() {
    // 1. Отслеживаем сохранения, сделанные самим пользователем через VS Code
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.userSaveTimes.set(path.normalize(doc.fileName), Date.now());
      })
    );

    // 2. Создаем системный наблюдатель за файлами проекта (включая удаление)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.disposables.push(
      watcher.onDidChange((uri) => this.handleFileEvent(uri)),
      watcher.onDidCreate((uri) => this.handleFileEvent(uri)),
      watcher.onDidDelete((uri) => this.handleFileEvent(uri)),
      watcher
    );

    // 3. Периодически очищаем устаревший кэш сохранений (каждые 30 секунд)
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [file, time] of this.userSaveTimes.entries()) {
        if (now - time > 5000) {
          this.userSaveTimes.delete(file);
        }
      }
    }, 30000);

    this.disposables.push({
      dispose: () => clearInterval(cleanupInterval),
    });
  }

  private handleFileEvent(uri: vscode.Uri) {
    const config = this.getConfig();
    if (!config.enable) {
      return;
    }

    const fsPath = path.normalize(uri.fsPath);
    const normalized = fsPath.replace(/\\/g, '/').toLowerCase();

    // 0. ЖЕСТКАЯ БЕЗУСЛОВНАЯ ЗАЩИТА: моментально пресекаем зацикливание и сканирование служебных папок
    if (
      normalized.includes('/.git/') ||
      normalized.endsWith('/.git') ||
      normalized.includes('/node_modules/') ||
      normalized.includes('/.agent-inspector/') ||
      normalized.includes('/.vscode/')
    ) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const rootPath = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();
    const relPath = path.relative(rootPath, fsPath);

    // 1. Быстрая проверка через .agentignore
    if (this.ignoreManager.isIgnored(relPath)) {
      return;
    }

    // 2. Проверяем список исключений из настроек
    if (matchesPattern(fsPath, config.ignorePatterns)) {
      return;
    }

    // 3. Проверяем, не было ли это сохранением самого пользователя
    // Если файл УЖЕ в нашем дереве правок — пропускаем проверку, чтобы зафиксировать Ctrl+Z или отмену!
    const isAlreadyTracked = this.isFileTracked(fsPath);
    const lastUserSave = this.userSaveTimes.get(fsPath);

    if (!isAlreadyTracked && lastUserSave && Date.now() - lastUserSave < 1500) {
      return;
    }

    // Добавляем файл в очередь обработки
    this.pendingChanges.set(fsPath, uri);

    // Запускаем дебаунс-таймер
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushQueue();
    }, config.debounceMs);
  }

  private async flushQueue() {
    let entries = Array.from(this.pendingChanges.entries());
    this.pendingChanges.clear();

    if (entries.length === 0) {
      return;
    }

    // ЗАЩИТА ОТ ЛАВИННЫХ СОБЫТИЙ (массовое копирование / распаковка):
    // Ограничиваем пакет до 50 файлов за итерацию, чтобы не спамить системными процессами
    if (entries.length > 50) {
      entries = entries.slice(0, 50);
    }

    const config = this.getConfig();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

    const changed: FileChangeInfo[] = [];
    const reverted: string[] = [];

    for (const [fsPath, uri] of entries) {
      const isProtected = matchesPattern(fsPath, config.protectedPatterns);
      const relativeName = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, fsPath)
        : path.basename(fsPath);

      // Получаем информацию о строках через быстрый git diff
      const gitInfo = await getGitDiffSummary(fsPath, workspaceRoot);

      if (gitInfo.hasChanges) {
        changed.push({
          uri,
          fsPath,
          relativeName,
          timestamp: Date.now(),
          changedLinesSummary: gitInfo.summaryText,
          firstChangedLine: gitInfo.firstChangedLine,
          addedLines: gitInfo.addedLines,
          deletedLines: gitInfo.deletedLines,
          isProtected,
          isUntracked: gitInfo.isUntracked,
          isDeleted: gitInfo.isDeleted,
        });
      } else {
        // Файл вернулся к исходному состоянию (нет изменений в Git: например, Ctrl+Z или git restore)
        reverted.push(fsPath);
      }
    }

    if (changed.length > 0 || reverted.length > 0) {
      this.onBatchProcessed(changed, reverted);
    }
  }

  dispose() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
