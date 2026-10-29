import * as vscode from 'vscode';
import { ExtensionConfig, FileChangeInfo, TurnCheckpoint } from './types';
import { SnapshotManager } from './snapshotManager';

function getNoun(number: number, one: string, two: string, five: string): string {
  let n = Math.abs(number);
  n %= 100;
  if (n >= 5 && n <= 20) {
    return five;
  }
  n %= 10;
  if (n === 1) {
    return one;
  }
  if (n >= 2 && n <= 4) {
    return two;
  }
  return five;
}

/**
 * Управление историей шагов выполнения промптов и авто-архивированием
 */
export class HistoryManager implements vscode.Disposable {
  private currentTurnChanges = new Map<string, FileChangeInfo>();
  private history: TurnCheckpoint[] = [];
  private activeTurnId = `turn_${Date.now()}`;
  private turnCounter = 1;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private snapshotManager: SnapshotManager;

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly getConfig: () => ExtensionConfig,
    private readonly workspaceRoot: string,
    storageDir?: string
  ) {
    this.snapshotManager = new SnapshotManager(storageDir, workspaceRoot);
  }

  /**
   * Получить текущие активные правки (текущий промпт)
   */
  getCurrentChanges(): FileChangeInfo[] {
    return Array.from(this.currentTurnChanges.values());
  }

  /**
   * Получить историю завершенных шагов (архив)
   */
  getHistory(): TurnCheckpoint[] {
    return this.history;
  }

  /**
   * Проверить, отслеживается ли файл в текущих правках
   */
  isCurrentFileTracked(fsPath: string): boolean {
    return this.currentTurnChanges.has(fsPath);
  }

  /**
   * Добавить или обновить изменения в текущем шаге
   */
  async recordChanges(changes: FileChangeInfo[]): Promise<void> {
    const config = this.getConfig();

    for (const change of changes) {
      // Сохраняем исходное состояние файла в снэпшот шага (хранится вне проекта)
      await this.snapshotManager.saveFileSnapshot(
        this.activeTurnId,
        change.fsPath,
        this.workspaceRoot
      );

      this.currentTurnChanges.set(change.fsPath, change);
    }

    this._onDidChange.fire();

    // Запускаем / сбрасываем таймер авто-архивирования по окну бездействия
    if (config.autoArchive) {
      if (this.cooldownTimer) {
        clearTimeout(this.cooldownTimer);
      }

      const cooldownMs = Math.max(3000, (config.autoArchiveSeconds || 8) * 1000);
      this.cooldownTimer = setTimeout(() => {
        this.archiveCurrentTurn();
      }, cooldownMs);
    }
  }

  /**
   * Удалить файл из текущего шага (например, при Ctrl+Z)
   */
  removeCurrentFile(fsPath: string): void {
    if (this.currentTurnChanges.delete(fsPath)) {
      this._onDidChange.fire();
    }
  }

  /**
   * Зафиксировать текущие изменения и перенести их в архив шагов
   */
  archiveCurrentTurn(): TurnCheckpoint | null {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    const files = Array.from(this.currentTurnChanges.values());
    if (files.length === 0) {
      return null;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    let totalAdded = 0;
    let totalDeleted = 0;
    for (const f of files) {
      totalAdded += f.addedLines;
      totalDeleted += f.deletedLines;
    }

    const diffPart = totalAdded > 0 || totalDeleted > 0 ? `: +${totalAdded}/-${totalDeleted}` : '';
    const noun = getNoun(files.length, 'файл', 'файла', 'файлов');

    const checkpoint: TurnCheckpoint = {
      id: this.activeTurnId,
      stepNumber: this.turnCounter,
      title: `Шаг ${this.turnCounter}: ${timeStr} (${files.length} ${noun}${diffPart})`,
      timestamp: Date.now(),
      files,
      snapshotDir: this.activeTurnId,
    };

    this.turnCounter++;
    this.history.unshift(checkpoint);

    // Ограничиваем историю 25 последними шагами
    if (this.history.length > 25) {
      this.history.pop();
    }

    this.currentTurnChanges.clear();
    this.activeTurnId = `turn_${Date.now()}`;

    // Очищаем снимки старых шагов
    this.snapshotManager.cleanupOldSnapshots(this.history.map((h) => h.id));

    this._onDidChange.fire();
    return checkpoint;
  }

  /**
   * Откатить указанный шаг из архива
   */
  async revertTurn(turnId: string): Promise<boolean> {
    const idx = this.history.findIndex((h) => h.id === turnId);
    if (idx === -1) {
      return false;
    }

    const checkpoint = this.history[idx];
    const ok = await this.snapshotManager.restoreTurn(checkpoint, this.workspaceRoot);

    if (ok) {
      this.history.splice(idx, 1);
      this._onDidChange.fire();
    }

    return ok;
  }

  /**
   * Очистить историю архива
   */
  clearHistory(): void {
    this.history = [];
    this.snapshotManager.cleanupOldSnapshots([]);
    this._onDidChange.fire();
  }

  /**
   * Очистить текущий активный шаг
   */
  clearCurrent(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.currentTurnChanges.clear();
    this.activeTurnId = `turn_${Date.now()}`;
    this._onDidChange.fire();
  }

  dispose() {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    this.currentTurnChanges.clear();
    this.history = [];
  }
}
