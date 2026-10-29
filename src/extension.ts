import * as vscode from 'vscode';
import { ExtensionConfig, FileChangeInfo } from './types';
import { ChangeDetector } from './detector';
import { DiffPresenter } from './diffPresenter';
import { StatusBarManager } from './statusBar';
import {
  AgentChangesTreeProvider,
  AgentTreeItem,
  TurnTreeItem,
  AgentFileDecorationProvider,
} from './treeProvider';
import { IgnoreManager } from './ignoreManager';
import { HistoryManager } from './historyManager';
import { DecorationManager } from './decorationManager';
import { SettingsWebviewPanel } from './settingsWebview';
import { revertGitFile } from './gitHelper';

/**
 * Чтение актуальной конфигурации расширения
 */
function getExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration('agentDiff');
  return {
    enable: cfg.get<boolean>('enable', true),
    autoOpen: cfg.get<boolean>('autoOpen', true),
    openMode: cfg.get<'diff' | 'document'>('openMode', 'diff'),
    openLocation: cfg.get<'beside' | 'active'>('openLocation', 'active'),
    jumpToFirstChange: cfg.get<boolean>('jumpToFirstChange', true),
    enableHighlight: cfg.get<boolean>('enableHighlight', true),
    showNotification: cfg.get<boolean>('showNotification', false),
    treeViewMode: cfg.get<'tree' | 'flat'>('treeViewMode', 'tree'),
    autoArchive: cfg.get<boolean>('autoArchive', true),
    autoArchiveSeconds: cfg.get<number>('autoArchiveSeconds', 8),
    protectedPatterns: cfg.get<string[]>('protectedPatterns', [
      '**/*.lock',
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/.env*',
      '**/protected/**',
    ]),
    ignorePatterns: cfg.get<string[]>('ignorePatterns', [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.agents/**',
      '**/.agent-inspector/**',
      '**/tmp/**',
    ]),
    debounceMs: cfg.get<number>('debounceMs', 400),
  };
}

export function activate(context: vscode.Context) {
  const config = getExtensionConfig();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

  const ignoreManager = new IgnoreManager();
  const historyManager = new HistoryManager(getExtensionConfig, workspaceRoot);
  const presenter = new DiffPresenter(getExtensionConfig);
  const treeProvider = new AgentChangesTreeProvider(historyManager, config.treeViewMode);

  // Провайдер подсветки удаленных файлов красным цветом в проводнике
  const decoProvider = new AgentFileDecorationProvider((uri) =>
    treeProvider.getChangeByUri(uri)
  );
  const decoSub = vscode.window.registerFileDecorationProvider(decoProvider);

  // Менеджер мягкой подсветки измененных строк в самом редакторе (Decorations + Gutter)
  const decorationManager = new DecorationManager((uri) => treeProvider.getChangeByUri(uri));
  decorationManager.setEnabled(config.enableHighlight);

  // 1. Панель в отдельном контейнере (для выноса вправо в Secondary Side Bar)
  const treeViewContainer = vscode.window.createTreeView('agent-inspector-files', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // 2. Дублирующая панель прямо в основном Проводнике слева
  const treeViewExplorer = vscode.window.createTreeView('agent-inspector-files-explorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const updateBadges = () => {
    const currentCount = historyManager.getCurrentChanges().length;
    const badge =
      currentCount > 0
        ? {
            value: currentCount,
            tooltip: `${currentCount} активных изменений`,
          }
        : undefined;
    treeViewContainer.badge = badge;
    treeViewExplorer.badge = badge;
  };

  const statusBar = new StatusBarManager(
    (change) => presenter.openDiffTab(change),
    () => getExtensionConfig().enable,
    () => {
      const cfg = vscode.workspace.getConfiguration('agentDiff');
      const current = cfg.get<boolean>('enable', true);
      cfg.update('enable', !current, vscode.ConfigurationTarget.Global);
    }
  );

  // Детектор внешних изменений с поддержкой авто-архивирования и отмены (Ctrl+Z)
  const detector = new ChangeDetector(
    getExtensionConfig,
    ignoreManager,
    (fsPath) => historyManager.isCurrentFileTracked(fsPath),
    async (changed, reverted) => {
      // 1. Убираем файлы, где изменения были отменены (например, Ctrl+Z)
      for (const fsPath of reverted) {
        historyManager.removeCurrentFile(fsPath);
      }

      // 2. Записываем активные изменения
      if (changed.length > 0) {
        await historyManager.recordChanges(changed);
        await presenter.presentChanges(changed);
      }

      // 3. Обновляем визуальные индикаторы и подсветку строк в коде
      decoProvider.refresh();
      decorationManager.refreshAllVisibleEditors();
      updateBadges();
      statusBar.updateChanges(historyManager.getCurrentChanges());
    }
  );

  // Вспомогательная функция для извлечения информации о файле из аргументов команды
  const extractChangeInfo = (item?: any): FileChangeInfo | undefined => {
    if (!item) {
      const all = historyManager.getCurrentChanges();
      return all.length > 0 ? all[all.length - 1] : undefined;
    }
    if ('changeInfo' in item) {
      return item.changeInfo;
    }
    if ('uri' in item) {
      return item;
    }
    return undefined;
  };

  // КОМАНДЫ ДЛЯ МЕНЮ И ДЕРЕВА
  const openSettingsCmd = vscode.commands.registerCommand('agentDiff.openSettings', () => {
    SettingsWebviewPanel.createOrShow(context.extensionUri, ignoreManager);
  });

  const toggleHighlightCmd = vscode.commands.registerCommand(
    'agentDiff.toggleHighlight',
    () => {
      const isNowOn = decorationManager.toggle();
      vscode.window.showInformationMessage(
        `Подсветка строк в коде: ${isNowOn ? 'Включена' : 'Выключена'}`
      );
    }
  );

  const archiveCurrentCmd = vscode.commands.registerCommand(
    'agentDiff.archiveCurrentStep',
    () => {
      const cp = historyManager.archiveCurrentTurn();
      if (cp) {
        decorationManager.refreshAllVisibleEditors();
        updateBadges();
        statusBar.updateChanges([]);
        vscode.window.showInformationMessage(`Шаг перенесен в архив: ${cp.title}`);
      } else {
        vscode.window.showInformationMessage('Нет активных изменений для архивации.');
      }
    }
  );

  const revertTurnCmd = vscode.commands.registerCommand(
    'agentDiff.revertTurn',
    async (item?: TurnTreeItem) => {
      if (!item || !item.checkpoint) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Откатить все файлы шага "${item.checkpoint.title}" (из .agent-inspector)?`,
        'Да, откатить',
        'Отмена'
      );
      if (answer === 'Да, откатить') {
        const ok = await historyManager.revertTurn(item.checkpoint.id);
        if (ok) {
          decoProvider.refresh();
          decorationManager.refreshAllVisibleEditors();
          updateBadges();
          vscode.window.showInformationMessage(`Шаг "${item.checkpoint.title}" успешно откачен.`);
        } else {
          vscode.window.showErrorMessage('Ошибка при откате шага.');
        }
      }
    }
  );

  const clearHistoryCmd = vscode.commands.registerCommand('agentDiff.clearHistory', async () => {
    const answer = await vscode.window.showWarningMessage(
      'Очистить всю историю завершенных шагов (архив)?',
      'Да, очистить',
      'Отмена'
    );
    if (answer === 'Да, очистить') {
      historyManager.clearHistory();
      vscode.window.showInformationMessage('История шагов очищена.');
    }
  });

  const openDiffCmd = vscode.commands.registerCommand(
    'agentDiff.openDiff',
    async (item?: any) => {
      const change = extractChangeInfo(item);
      if (change) {
        await presenter.openDiffTab(change);
      }
    }
  );

  const openFileCmd = vscode.commands.registerCommand(
    'agentDiff.openFile',
    async (item?: any) => {
      const change = extractChangeInfo(item);
      if (change) {
        await presenter.openDocumentTab(change);
      }
    }
  );

  const revertFileCmd = vscode.commands.registerCommand(
    'agentDiff.revertFile',
    async (item?: AgentTreeItem) => {
      const change = extractChangeInfo(item);
      if (!change) {
        return;
      }

      const ok = await revertGitFile(change.fsPath, workspaceRoot);
      if (ok) {
        historyManager.removeCurrentFile(change.fsPath);
        decoProvider.refresh();
        decorationManager.refreshAllVisibleEditors();
        updateBadges();
        statusBar.updateChanges(historyManager.getCurrentChanges());
        vscode.window.showInformationMessage(
          `Файл ${change.relativeName} откачен / восстановлен.`
        );
      } else {
        vscode.window.showErrorMessage(`Не удалось откатить файл ${change.relativeName}.`);
      }
    }
  );

  const refreshTreeCmd = vscode.commands.registerCommand('agentDiff.refreshTree', async () => {
    await treeProvider.reconcileWithGit(workspaceRoot);
    decoProvider.refresh();
    decorationManager.refreshAllVisibleEditors();
    updateBadges();
    statusBar.updateChanges(historyManager.getCurrentChanges());
  });

  const toggleTreeModeCmd = vscode.commands.registerCommand('agentDiff.toggleTreeMode', () => {
    const newMode = treeProvider.toggleTreeMode();
    vscode.window.showInformationMessage(
      `Режим проводника правок: ${newMode === 'tree' ? 'Дерево папок' : 'Плоский список'}`
    );
  });

  const clearAllCmd = vscode.commands.registerCommand('agentDiff.clearAllChanges', () => {
    historyManager.clearCurrent();
    decoProvider.refresh();
    decorationManager.refreshAllVisibleEditors();
    updateBadges();
    statusBar.updateChanges([]);
    vscode.window.showInformationMessage('Текущие изменения очищены.');
  });

  const revertAllCmd = vscode.commands.registerCommand('agentDiff.revertAllChanges', async () => {
    const current = historyManager.getCurrentChanges();
    if (current.length === 0) {
      vscode.window.showInformationMessage('Нет активных изменений для отката.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Откатить ВСЕ (${current.length}) текущие измененные / удаленные файлы?`,
      'Да, откатить все',
      'Отмена'
    );

    if (answer === 'Да, откатить все') {
      for (const change of current) {
        await revertGitFile(change.fsPath, workspaceRoot);
      }

      historyManager.clearCurrent();
      decoProvider.refresh();
      decorationManager.refreshAllVisibleEditors();
      updateBadges();
      statusBar.updateChanges([]);
      vscode.window.showInformationMessage('Все текущие изменения успешно откатаны.');
    }
  });

  const toggleCmd = vscode.commands.registerCommand('agentDiff.toggle', () => {
    const cfg = vscode.workspace.getConfiguration('agentDiff');
    const current = cfg.get<boolean>('enable', true);
    cfg.update('enable', !current, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `Отслеживание изменений ИИ: ${!current ? 'Включено' : 'Выключено'}`
    );
  });

  const showRecentCmd = vscode.commands.registerCommand('agentDiff.showRecentChanges', () => {
    statusBar.showMenu();
  });

  // Отслеживание обновления настроек
  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('agentDiff')) {
      const updatedConfig = getExtensionConfig();
      treeProvider.setTreeMode(updatedConfig.treeViewMode);
      decorationManager.setEnabled(updatedConfig.enableHighlight);
      statusBar.updateStatus();
    }
  });

  context.subscriptions.push(
    ignoreManager,
    historyManager,
    decorationManager,
    treeViewContainer,
    treeViewExplorer,
    decoSub,
    detector,
    statusBar,
    toggleHighlightCmd,
    archiveCurrentCmd,
    revertTurnCmd,
    clearHistoryCmd,
    openSettingsCmd,
    openDiffCmd,
    openFileCmd,
    revertFileCmd,
    refreshTreeCmd,
    toggleTreeModeCmd,
    clearAllCmd,
    revertAllCmd,
    toggleCmd,
    showRecentCmd,
    configWatcher
  );
}

export function deactivate() {}
