import * as vscode from 'vscode';
import { ExtensionConfig, FileChangeInfo, TurnCheckpoint } from './types';
import { StorageManager, formatArchiveTimestamp } from './storageManager';
import { BaselineManager } from './baselineManager';

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
 * Управление шагами правок, активными изменениями и архивом в .agent-inspector
 */
export class HistoryManager implements vscode.Disposable {
  private currentTurnChanges = new Map<string, FileChangeInfo>();
  private history: TurnCheckpoint[] = [];
  private activeFolderName = formatArchiveTimestamp();
  private turnCounter = 1;
  private cooldownTimer: NodeJS.Timeout | null = null;

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly getConfig: () => ExtensionConfig,
    private readonly storageManager: StorageManager,
    private readonly baselineManager: BaselineManager
  ) {
    this.initHistory();
  }

  private async initHistory() {
    this.history = await this.storageManager.loadHistory();
    this.turnCounter = this.history.length + 1;
    this._onDidChange.fire();
  }

  getActiveFolderName(): string {
    return this.activeFolderName;
  }

  getCurrentChanges(): FileChangeInfo[] {
    return Array.from(this.currentTurnChanges.values());
  }

  getHistory(): TurnCheckpoint[] {
    return this.history;
  }

  isCurrentFileTracked(fsPath: string): boolean {
    return this.currentTurnChanges.has(fsPath);
  }

  /**
   * Записать новые или обновленные активные изменения
   */
  async recordChanges(changes: FileChangeInfo[]): Promise<void> {
    for (const change of changes) {
      this.currentTurnChanges.set(change.fsPath, change);
    }

    // Сохраняем актуальное дерево в current.json
    await this.storageManager.saveCurrentTree(
      Array.from(this.currentTurnChanges.values()),
      this.activeFolderName
    );

    this._onDidChange.fire();

    // Опциональный авто-архив (если включен в настройках)
    const config = this.getConfig();
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
      this.storageManager.saveCurrentTree(
        Array.from(this.currentTurnChanges.values()),
        this.activeFolderName
      );
      this._onDidChange.fire();
    }
  }

  /**
   * Откатить отдельный файл в текущем шаге
   */
  async revertCurrentFile(fsPath: string): Promise<boolean> {
    const change = this.currentTurnChanges.get(fsPath);
    if (!change) {
      return false;
    }

    const ok = await this.storageManager.restoreFileFromSnapshot(this.activeFolderName, change);
    if (ok) {
      this.removeCurrentFile(fsPath);
    }
    return ok;
  }

  /**
   * Откатить ВСЕ активные изменения текущего шага
   */
  async revertAllCurrentChanges(): Promise<boolean> {
    const current = this.getCurrentChanges();
    if (current.length === 0) {
      return true;
    }

    let allOk = true;
    for (const change of current) {
      const ok = await this.storageManager.restoreFileFromSnapshot(this.activeFolderName, change);
      if (!ok) {
        allOk = false;
      }
    }

    this.currentTurnChanges.clear();
    await this.storageManager.saveCurrentTree([], this.activeFolderName);
    this._onDidChange.fire();
    return allOk;
  }

  /**
   * Зафиксировать текущий шаг (вручную по кнопке или авто)
   */
  async archiveCurrentTurn(): Promise<TurnCheckpoint | null> {
    const files = this.getCurrentChanges();
    if (files.length === 0) {
      return null;
    }

    const d = new Date();
    const timeStr = d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const fileWord = getNoun(files.length, 'файл', 'файла', 'файлов');

    const checkpoint: TurnCheckpoint = {
      id: this.activeFolderName,
      stepNumber: this.turnCounter++,
      title: `Шаг №${this.turnCounter - 1} (${timeStr}) — ${files.length} ${fileWord}`,
      timestamp: Date.now(),
      folderName: this.activeFolderName,
      files,
    };

    // 1. Сохраняем манифест дерева шага в .agent-inspector/tree/<folderName>.json
    await this.storageManager.archiveStep(checkpoint);

    // 2. Обновляем базовую линию (зафиксированные изменения становятся новым baseline)
    await this.baselineManager.commitChanges(files);

    // 3. Добавляем в историю (новые шаги сверху)
    this.history.unshift(checkpoint);

    // 4. Очищаем текущий шаг и готовим новую папку для следующего шага
    this.currentTurnChanges.clear();
    this.activeFolderName = formatArchiveTimestamp();

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }

    this._onDidChange.fire();
    return checkpoint;
  }

  /**
   * Откатить шаг из архива
   */
  async revertTurn(checkpointId: string): Promise<boolean> {
    const cp = this.history.find((h) => h.id === checkpointId);
    if (!cp) {
      return false;
    }

    const ok = await this.storageManager.restoreStep(cp);
    if (ok) {
      // Обновляем baseline после отката
      await this.baselineManager.revertChangesToBaseline(cp.files);
      this._onDidChange.fire();
    }
    return ok;
  }

  /**
   * Восстановить отдельный файл из архивного шага
   */
  async restoreFileFromArchive(checkpointId: string, relPath: string): Promise<boolean> {
    const cp = this.history.find((h) => h.id === checkpointId);
    if (!cp) {
      return false;
    }

    const file = cp.files.find((f) => f.relativeName === relPath);
    if (!file) {
      return false;
    }

    return await this.storageManager.restoreFileFromSnapshot(cp.folderName, file);
  }

  /**
   * Очистить историю шагов
   */
  async clearHistory(): Promise<void> {
    await this.storageManager.clearAllHistory();
    this.history = [];
    this._onDidChange.fire();
  }

  clearCurrent(): void {
    this.currentTurnChanges.clear();
    this.storageManager.saveCurrentTree([], this.activeFolderName);
    this._onDidChange.fire();
  }

  dispose() {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    this._onDidChange.dispose();
  }
}
