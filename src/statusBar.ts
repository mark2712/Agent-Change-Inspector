import * as vscode from 'vscode';
import { FileChangeInfo } from './types';

/**
 * Управление строкой состояния и всплывающим меню быстрого доступа
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
   * Обновить список активных изменений
   */
  updateChanges(changes: FileChangeInfo[]) {
    this.recentChanges = changes;
    this.updateStatus();
  }

  /**
   * Обновить отображение иконки и текста в строке состояния
   */
  updateStatus() {
    if (!this.isEnabled()) {
      this.statusBarItem.text = '$(circle-slash) AI Diff: Выкл';
      this.statusBarItem.tooltip = 'Отслеживание изменений выключено. Кликните для включения.';
      return;
    }

    if (this.recentChanges.length === 0) {
      this.statusBarItem.text = '$(hubot) AI Diff: Ожидание';
      this.statusBarItem.tooltip = 'Ожидание правок в проекте. Кликните для вызова меню.';
    } else {
      const count = this.recentChanges.length;
      const last = this.recentChanges[this.recentChanges.length - 1];
      this.statusBarItem.text = `$(hubot) AI (${count}): ${last.relativeName} (${last.changedLinesSummary})`;
      this.statusBarItem.tooltip = `Активных файлов: ${count}\nПоследнее изменение: ${last.relativeName} (${last.changedLinesSummary})\nКликните для фиксации шага или просмотра списка.`;
    }
  }

  /**
   * Меню быстрого доступа QuickPick
   */
  async showMenu() {
    interface QuickActionItem extends vscode.QuickPickItem {
      actionType: 'open' | 'archive' | 'revert_all' | 'toggle' | 'treeMode' | 'highlight' | 'settings';
      change?: FileChangeInfo;
    }

    const items: QuickActionItem[] = [];

    // Если есть активные изменения — даем кнопку фиксации шага на самом верху!
    if (this.recentChanges.length > 0) {
      items.push({
        label: `$(archive) Зафиксировать текущий шаг (${this.recentChanges.length} файлов)`,
        description: 'Сохранить снимок в .agent-inspector и перенести в историю',
        actionType: 'archive',
      });

      items.push({
        label: '$(discard) Откатить ВСЕ активные изменения',
        description: 'Восстановить все файлы из исходных снимков',
        actionType: 'revert_all',
      });

      items.push({
        label: 'АКТИВНЫЕ ПРАВКИ (кликните для открытия Diff):',
        kind: vscode.QuickPickItemKind.Separator,
        actionType: 'archive',
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
    }

    items.push({
      label: 'УПРАВЛЕНИЕ И НАСТРОЙКИ:',
      kind: vscode.QuickPickItemKind.Separator,
      actionType: 'archive',
    });

    items.push({
      label: '$(paintcan) Переключить подсветку строк в коде',
      description: 'Включить/выключить маркеры и фон измененных строк',
      actionType: 'highlight',
    });

    items.push({
      label: '$(list-tree) Переключить вид (Дерево / Список)',
      description: 'Сменить режим отображения в проводнике',
      actionType: 'treeMode',
    });

    items.push({
      label: '$(gear) Настройки Agent Inspector',
      description: 'Открыть панель настроек и правил исключений',
      actionType: 'settings',
    });

    items.push({
      label: this.isEnabled()
        ? '$(circle-slash) Отключить авто-отслеживание'
        : '$(check) Включить авто-отслеживание',
      description: 'Глобальное переключение активности расширения',
      actionType: 'toggle',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Agent Change Inspector — Выберите действие',
    });

    if (!selected) {
      return;
    }

    switch (selected.actionType) {
      case 'open':
        if (selected.change) {
          this.onSelectFile(selected.change);
        }
        break;
      case 'archive':
        await vscode.commands.executeCommand('agentDiff.archiveCurrentStep');
        break;
      case 'revert_all':
        await vscode.commands.executeCommand('agentDiff.revertAllChanges');
        break;
      case 'highlight':
        await vscode.commands.executeCommand('agentDiff.toggleHighlight');
        break;
      case 'treeMode':
        await vscode.commands.executeCommand('agentDiff.toggleTreeMode');
        break;
      case 'settings':
        await vscode.commands.executeCommand('agentDiff.openSettings');
        break;
      case 'toggle':
        this.onToggleEnabled();
        this.updateStatus();
        break;
    }
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}
