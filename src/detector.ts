import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionConfig, FileChangeInfo } from './types';
import { IgnoreManager } from './ignoreManager';
import { BaselineManager } from './baselineManager';

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
 * Детектор любых внешних и внутренних изменений файлов проекта
 * (проводник Windows, Python-скрипты, Git, терминал, редакторы VS Code)
 * с защитой от лавинных событий по таймеру 200 мс.
 */
export class ChangeDetector implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private pendingChanges = new Map<string, vscode.Uri>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private userSaveTimes = new Map<string, number>();

  // Защита от массового копирования / перемещения:
  // Если изменения сыплются с интервалом менее 200 мс — запрещаем авто-открытие вкладок
  private lastEventTimestamp = 0;
  private isBurstMode = false;
  private burstResetTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getConfig: () => ExtensionConfig,
    private readonly ignoreManager: IgnoreManager,
    private readonly baselineManager: BaselineManager,
    private readonly getActiveFolder: () => string,
    private readonly isFileTracked: (fsPath: string) => boolean,
    private readonly onBatchProcessed: (
      changed: FileChangeInfo[],
      revertedPaths: string[],
      shouldAutoOpen: boolean
    ) => void
  ) {
    this.registerListeners();
  }

  private registerListeners() {
    // 1. Создаем глобальный системный наблюдатель за файловой системой проекта
    // (ловит любые внешние изменения: Python, Explorer, cmd, git и т.д.)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.disposables.push(
      watcher.onDidChange((uri) => this.handleFileEvent(uri)),
      watcher.onDidCreate((uri) => this.handleFileEvent(uri)),
      watcher.onDidDelete((uri) => this.handleFileEvent(uri)),
      watcher
    );

    // 2. Также слушаем сохранения внутри VS Code (Ctrl+S, меню Сохранить, автосохранение)
    this.disposables.push(
      vscode.workspace.onWillSaveTextDocument((e) => {
        const fsPath = path.normalize(e.document.fileName);
        this.userSaveTimes.set(fsPath, Date.now());
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const fsPath = path.normalize(doc.fileName);
        this.userSaveTimes.set(fsPath, Date.now());
        this.handleFileEvent(doc.uri);
      })
    );
  }

  private handleFileEvent(uri: vscode.Uri) {
    const config = this.getConfig();
    if (!config.enable) {
      return;
    }

    const fsPath = path.normalize(uri.fsPath);
    const normalized = fsPath.replace(/\\/g, '/').toLowerCase();

    // 0. ЖЕСТКАЯ БЕЗУСЛОВНАЯ ЗАЩИТА: моментально пресекаем служебные папки и рекурсию
    if (
      normalized.includes('/.git/') ||
      normalized.endsWith('/.git') ||
      normalized.includes('/node_modules/') ||
      normalized.includes('/.agent-inspector/') ||
      normalized.includes('/.vscode/') ||
      normalized.includes('/dist/') ||
      normalized.includes('/build/')
    ) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const rootPath = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();
    const relPath = path.relative(rootPath, fsPath).replace(/\\/g, '/');

    // 1. Проверка через .agent-inspector/.agentignore
    if (this.ignoreManager.isIgnored(relPath)) {
      return;
    }

    // 2. Проверка через список исключений настроек
    if (matchesPattern(fsPath, config.ignorePatterns)) {
      return;
    }

    // 3. ТАЙМЕР-ЗАЩИТА ОТ КОПИРОВАНИЯ И ПЕРЕМЕЩЕНИЯ (200 мс):
    // Если событие пришло меньше чем за 200 мс с момента предыдущего — включаем режим пачки
    const now = Date.now();
    const interval = now - this.lastEventTimestamp;
    this.lastEventTimestamp = now;

    const threshold = config.burstThresholdMs || 200;
    if (interval < threshold) {
      this.isBurstMode = true;
    }

    if (this.burstResetTimer) {
      clearTimeout(this.burstResetTimer);
    }
    this.burstResetTimer = setTimeout(() => {
      this.isBurstMode = false;
    }, Math.max(300, threshold + 100));

    // Добавляем файл в очередь отложенной обработки
    this.pendingChanges.set(fsPath, uri);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushQueue();
    }, config.debounceMs || 300);
  }

  private async flushQueue() {
    const entries = Array.from(this.pendingChanges.entries());
    this.pendingChanges.clear();

    if (entries.length === 0) {
      return;
    }

    const config = this.getConfig();
    const currentStepFolder = this.getActiveFolder();

    // Защита: если зафиксирован лавинный поток или в очереди более 3 файлов — во вкладках НЕ открываем!
    const shouldAutoOpen = !this.isBurstMode && entries.length <= 3;

    const changed: FileChangeInfo[] = [];
    const reverted: string[] = [];
    const now = Date.now();

    for (const [fsPath] of entries) {
      const isProtected = matchesPattern(fsPath, config.protectedPatterns);
      const lastUserSave = this.userSaveTimes.get(fsPath);
      // Если файл был сохранен внутри VS Code менее 2.5 сек назад — это ручное сохранение пользователя
      const isUserSave = !!lastUserSave && now - lastUserSave < 2500;

      // Вычисляем изменение через BaselineManager
      const change = await this.baselineManager.inspectFileChange(
        fsPath,
        currentStepFolder,
        isProtected
      );

      if (change) {
        change.isUserSave = isUserSave;
        changed.push(change);
      } else {
        // Если изменений нет, но файл ранее был в списке правок — значит, был Ctrl+Z или откат
        if (this.isFileTracked(fsPath)) {
          reverted.push(fsPath);
        }
      }
    }

    // Очищаем устаревший кэш сохранений пользователя (старше 5 секунд)
    for (const [file, time] of this.userSaveTimes.entries()) {
      if (now - time > 5000) {
        this.userSaveTimes.delete(file);
      }
    }

    if (changed.length > 0 || reverted.length > 0) {
      this.onBatchProcessed(changed, reverted, shouldAutoOpen);
    }
  }

  dispose() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.burstResetTimer) {
      clearTimeout(this.burstResetTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
