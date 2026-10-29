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
 * Детектор внешних изменений файлов
 */
export class ChangeDetector implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private userSaveTimes = new Map<string, number>();
  private pendingChanges = new Map<string, vscode.Uri>();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getConfig: () => ExtensionConfig,
    private readonly ignoreManager: IgnoreManager,
    private readonly onExternalChanges: (changes: FileChangeInfo[]) => void
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

    // 2. Создаем системный наблюдатель за файлами проекта
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
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const rootPath = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();
    const relPath = path.relative(rootPath, fsPath);

    // 1. Быстрая проверка через .agentignore
    if (this.ignoreManager.isIgnored(relPath)) {
      return;
    }

    // 2. Проверяем список исключений из настроек (для обратной совместимости)
    if (matchesPattern(fsPath, config.ignorePatterns)) {
      return;
    }

    // 3. Проверяем, не было ли это сохранением самого пользователя за последние 1.5 сек
    const lastUserSave = this.userSaveTimes.get(fsPath);
    if (lastUserSave && Date.now() - lastUserSave < 1500) {
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
    const entries = Array.from(this.pendingChanges.entries());
    this.pendingChanges.clear();

    if (entries.length === 0) {
      return;
    }

    const config = this.getConfig();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

    const results: FileChangeInfo[] = [];

    for (const [fsPath, uri] of entries) {
      const isProtected = matchesPattern(fsPath, config.protectedPatterns);
      const relativeName = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, fsPath)
        : path.basename(fsPath);

      // Получаем информацию о строках через быстрый git diff
      const gitInfo = await getGitDiffSummary(fsPath, workspaceRoot);

      if (gitInfo.hasChanges) {
        results.push({
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
      }
    }

    if (results.length > 0) {
      this.onExternalChanges(results);
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
