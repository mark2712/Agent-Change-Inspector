import * as vscode from 'vscode';
import { FileChangeInfo } from './types';
import { revertGitFile } from './gitHelper';

/**
 * Управление строкой состояния и меню быстрого доступа
 */
export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private recentChanges: FileChangeInfo[] = [];

  constructor(
    private readonly onSelectFile: (change: FileChangeInfo) => void,
    private readonly isEnabled: () => boolean,
    private readonly onToggleEnabled: () => void
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = 'agentDiff.showRecentChanges';
    this.updateStatus();
    this.statusBarItem.show();
  }

  /**
   * Обновить список последних изменений
   */
  updateChanges(changes: FileChangeInfo[]) {
    // Сохраняем последние 20 изменений
    const existingMap = new Map(this.recentChanges.map((c) => [c.fsPath, c]));
    for (const change of changes) {
      existingMap.set(change.fsPath, change);
    }
    this.recentChanges = Array.from(existingMap.values()).slice(-20);
    this.updateStatus();
  }

  /**
   * Обновить отображение иконки и текста в строке состояния
   */
  updateStatus() {
    if (!this.isEnabled()) {
      this.statusBarItem.text = '$(circle-slash) AI Diff: Выкл';
      this.statusBarItem.tooltip = 'Отслеживание изменений ИИ выключено. Кликните для включения.';
      return;
    }

    if (this.recentChanges.length === 0) {
      this.statusBarItem.text = '$(hubot) AI Diff: Ожидание';
      this.statusBarItem.tooltip = 'Ожидание правок от ИИ/агента. Кликните для просмотра меню.';
    } else {
      const last = this.recentChanges[this.recentChanges.length - 1];
      this.statusBarItem.text = `$(hubot) ИИ: ${last.relativeName} (${last.changedLinesSummary})`;
      this.statusBarItem.tooltip = `Последнее изменение: ${last.relativeName}\n${last.changedLinesSummary}\nКликните для списка всех измененных файлов.`;
    }
  }

  /**
   * Показать меню QuickPick со списком файлов и действиями
   */
  async showMenu() {
    interface QuickPickItemWithAction extends vscode.QuickPickItem {
      actionType: 'open' | 'revert_one' | 'revert_all' | 'toggle' | 'clear';
      change?: FileChangeInfo;
    }

    const items: QuickPickItemWithAction[] = [];

    // Список последних файлов
    if (this.recentChanges.length > 0) {
      items.push({
        label: 'ИЗМЕНЕННЫЕ ФАЙЛЫ (кликните для открытия Diff):',
        kind: vscode.QuickPickItemKind.Separator,
        actionType: 'clear',
      });

      for (const change of [...this.recentChanges].reverse()) {
        items.push({
          label: `$(diff) ${change.relativeName}`,
          description: change.changedLinesSummary,
          detail: `Путь: ${change.fsPath}`,
          actionType: 'open',
          change,
        });
      }

      items.push({
        label: 'ДЕЙСТВИЯ:',
        kind: vscode.QuickPickItemKind.Separator,
        actionType: 'clear',
      });

      items.push({
        label: '$(discard) Откатить ВСЕ недавние изменения ИИ',
        description: 'Выполнить git restore для всех файлов в списке',
        actionType: 'revert_all',
      });
    }

    items.push({
      label: this.isEnabled()
        ? '$(circle-slash) Отключить авто-отслеживание'
        : '$(check) Включить авто-отслеживание',
      description: 'Переключить режим фонового наблюдения',
      actionType: 'toggle',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Выберите файл для просмотра или действие',
    });

    if (!selected) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

    if (selected.actionType === 'open' && selected.change) {
      this.onSelectFile(selected.change);
    } else if (selected.actionType === 'toggle') {
      this.onToggleEnabled();
      this.updateStatus();
    } else if (selected.actionType === 'revert_all') {
      const confirm = await vscode.window.showWarningMessage(
        `Вы уверены, что хотите откатить все (${this.recentChanges.length}) измененные файлы?`,
        'Да, откатить все',
        'Отмена'
      );
      if (confirm === 'Да, откатить все') {
        for (const change of this.recentChanges) {
          await revertGitFile(change.fsPath, workspaceRoot);
        }
        this.recentChanges = [];
        this.updateStatus();
        vscode.window.showInformationMessage('Все недавние изменения успешно откатаны.');
      }
    }
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}
