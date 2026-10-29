import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
import { StorageManager } from './storageManager';
import { BaselineManager } from './baselineManager';
import { HistoryManager } from './historyManager';
import { DecorationManager } from './decorationManager';
import { SettingsWebviewPanel } from './settingsWebview';

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
    maxAutoOpenFiles: cfg.get<number>('maxAutoOpenFiles', 3),
    showNotification: cfg.get<boolean>('showNotification', false),
    treeViewMode: cfg.get<'tree' | 'flat'>('treeViewMode', 'tree'),
    autoArchive: cfg.get<boolean>('autoArchive', false), // По умолчанию шаг фиксируется вручную по кнопке
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
    debounceMs: cfg.get<number>('debounceMs', 300),
    maxFileSizeBytes: cfg.get<number>('maxFileSizeBytes', 2 * 1024 * 1024),
    burstThresholdMs: cfg.get<number>('burstThresholdMs', 200),
  };
}

export function activate(context: vscode.ExtensionContext) {
  const config = getExtensionConfig();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

  // 1. Менеджеры хранилища, правил и базовой линии
  const ignoreManager = new IgnoreManager();
  const storageManager = new StorageManager(workspaceRoot);
  const baselineManager = new BaselineManager(
    workspaceRoot,
    storageManager,
    ignoreManager,
    config.maxFileSizeBytes
  );

  // Инициализируем baseline в фоне
  baselineManager.initialize().catch((err) => {
    console.error('[AgentInspector] Ошибка инициализации BaselineManager:', err);
  });

  const historyManager = new HistoryManager(
    getExtensionConfig,
    storageManager,
    baselineManager
  );

  const presenter = new DiffPresenter(
    getExtensionConfig,
    async (change) => historyManager.revertCurrentFile(change.fsPath)
  );

  const treeProvider = new AgentChangesTreeProvider(historyManager, config.treeViewMode);

  // Провайдер бейджей статуса (M, A, D) в проводнике (только для активных правок)
  const decoProvider = new AgentFileDecorationProvider((uri) =>
    treeProvider.getActiveChangeByUri(uri)
  );
  const decoSub = vscode.window.registerFileDecorationProvider(decoProvider);

  // Менеджер полосок на полях (Gutter), фона строк и маркеров скроллбара (только для активных правок)
  const decorationManager = new DecorationManager(
    context.extensionUri,
    (uri) => treeProvider.getActiveChangeByUri(uri)
  );
  decorationManager.setEnabled(config.enableHighlight);

  // Панели дерева:
  // 1. Вторичная боковая панель (Activity Bar)
  const treeViewContainer = vscode.window.createTreeView('agent-inspector-files', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // 2. Основной проводник слева
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

  // Детектор изменений файлов проекта с защитой 200 мс от копирования
  const detector = new ChangeDetector(
    getExtensionConfig,
    ignoreManager,
    baselineManager,
    () => historyManager.getActiveFolderName(),
    (fsPath) => historyManager.isCurrentFileTracked(fsPath),
    async (changed, reverted, shouldAutoOpen) => {
      // 1. Убираем файлы, где изменения были отменены (например, Ctrl+Z)
      for (const fsPath of reverted) {
        historyManager.removeCurrentFile(fsPath);
      }

      // 2. Фиксируем активные изменения
      if (changed.length > 0) {
        await historyManager.recordChanges(changed);
        await presenter.presentChanges(changed, shouldAutoOpen);
      }

      // 3. Обновляем визуальные индикаторы
      decoProvider.refresh();
      decorationManager.refreshAllVisibleEditors();
      updateBadges();
      statusBar.updateChanges(historyManager.getCurrentChanges());
    }
  );

  // Вспомогательная функция для извлечения информации о файле из контекста команды
  const extractChangeInfo = (item?: any): FileChangeInfo | undefined => {
    if (!item) {
      const all = historyManager.getCurrentChanges();
      return all.length > 0 ? all[all.length - 1] : undefined;
    }
    if ('changeInfo' in item) {
      return item.changeInfo;
    }
    if ('uri' in item) {
      return treeProvider.getChangeByUri(item.uri);
    }
    return undefined;
  };

  // КОМАНДЫ РАСШИРЕНИЯ

  // 1. Фиксация шага по кнопке, хоткею (Ctrl+PageDown) или команде
  const archiveCurrentCmd = vscode.commands.registerCommand(
    'agentDiff.archiveCurrentStep',
    async (customTitle?: string) => {
      const cp = await historyManager.archiveCurrentTurn(
        typeof customTitle === 'string' ? customTitle : undefined
      );
      if (cp) {
        decoProvider.refresh();
        decorationManager.refreshAllVisibleEditors();
        updateBadges();
        statusBar.updateChanges([]);
        vscode.window.showInformationMessage(`Шаг зафиксирован в архив: ${cp.title}`);
      } else {
        vscode.window.showInformationMessage('Нет активных изменений для фиксации шага.');
      }
    }
  );

  // 2. Открыть Diff со снимком
  const openDiffCmd = vscode.commands.registerCommand(
    'agentDiff.openDiff',
    async (item?: any) => {
      const change = extractChangeInfo(item);
      if (change) {
        await presenter.openDiffTab(change);
      }
    }
  );

  // 3. Открыть файл как обычную вкладку
  const openFileCmd = vscode.commands.registerCommand(
    'agentDiff.openFile',
    async (item?: any) => {
      const change = extractChangeInfo(item);
      if (change) {
        await presenter.openDocumentTab(change);
      }
    }
  );

  // 4. Откатить отдельный файл
  const revertFileCmd = vscode.commands.registerCommand(
    'agentDiff.revertFile',
    async (item?: AgentTreeItem) => {
      const change = extractChangeInfo(item);
      if (!change) {
        return;
      }

      const ok = await historyManager.revertCurrentFile(change.fsPath);
      if (ok) {
        decoProvider.refresh();
        decorationManager.refreshAllVisibleEditors();
        updateBadges();
        statusBar.updateChanges(historyManager.getCurrentChanges());
        vscode.window.showInformationMessage(`Файл ${change.relativeName} восстановлен из снимка.`);
      } else {
        vscode.window.showErrorMessage(`Не удалось откатить файл ${change.relativeName}.`);
      }
    }
  );

  // 5. Откатить весь шаг из архива
  const revertTurnCmd = vscode.commands.registerCommand(
    'agentDiff.revertTurn',
    async (item?: TurnTreeItem) => {
      if (!item || !item.checkpoint) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Откатить все файлы шага "${item.checkpoint.title}" из архива снимков?`,
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

  // 6. Откатить ВСЕ активные изменения
  const revertAllCmd = vscode.commands.registerCommand(
    'agentDiff.revertAllChanges',
    async () => {
      const current = historyManager.getCurrentChanges();
      if (current.length === 0) {
        vscode.window.showInformationMessage('Нет активных изменений для отката.');
        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `Откатить ВСЕ (${current.length}) активные измененные / созданные / удаленные файлы?`,
        'Да, откатить все',
        'Отмена'
      );

      if (answer === 'Да, откатить все') {
        await historyManager.revertAllCurrentChanges();
        decoProvider.refresh();
        decorationManager.refreshAllVisibleEditors();
        updateBadges();
        statusBar.updateChanges([]);
        vscode.window.showInformationMessage('Все текущие изменения успешно откатаны.');
      }
    }
  );

  // 7. Очистить текущий список изменений без отката на диске
  const clearAllCmd = vscode.commands.registerCommand('agentDiff.clearAllChanges', () => {
    historyManager.clearCurrent();
    decoProvider.refresh();
    decorationManager.refreshAllVisibleEditors();
    updateBadges();
    statusBar.updateChanges([]);
    vscode.window.showInformationMessage('Список текущих изменений очищен.');
  });

  // 8. Очистить всю историю шагов (архив)
  const clearHistoryCmd = vscode.commands.registerCommand(
    'agentDiff.clearHistory',
    async () => {
      const answer = await vscode.window.showWarningMessage(
        'Очистить всю историю завершенных шагов (папки в .agent-inspector)?',
        'Да, очистить',
        'Отмена'
      );
      if (answer === 'Да, очистить') {
        await historyManager.clearHistory();
        vscode.window.showInformationMessage('История шагов очищена.');
      }
    }
  );

  // 9. Переключить режим (Дерево / Список)
  const toggleTreeModeCmd = vscode.commands.registerCommand(
    'agentDiff.toggleTreeMode',
    () => {
      const newMode = treeProvider.toggleTreeMode();
      vscode.window.showInformationMessage(
        `Режим проводника: ${newMode === 'tree' ? 'Иерархическое дерево' : 'Плоский список'}`
      );
    }
  );

  // 10. Переключить подсветку строк в редакторе
  const toggleHighlightCmd = vscode.commands.registerCommand(
    'agentDiff.toggleHighlight',
    () => {
      const isNowOn = decorationManager.toggle();
      vscode.window.showInformationMessage(
        `Подсветка строк в коде: ${isNowOn ? 'Включена' : 'Выключена'}`
      );
    }
  );

  // 11. Обновить дерево
  const refreshTreeCmd = vscode.commands.registerCommand('agentDiff.refreshTree', async () => {
    treeProvider.refresh();
    decoProvider.refresh();
    decorationManager.refreshAllVisibleEditors();
    updateBadges();
    statusBar.updateChanges(historyManager.getCurrentChanges());
  });

  // 12. Открыть настройки
  const openSettingsCmd = vscode.commands.registerCommand('agentDiff.openSettings', () => {
    SettingsWebviewPanel.createOrShow(context.extensionUri, ignoreManager);
  });

  // 13. Глобальное включение/выключение
  const toggleCmd = vscode.commands.registerCommand('agentDiff.toggle', () => {
    const cfg = vscode.workspace.getConfiguration('agentDiff');
    const current = cfg.get<boolean>('enable', true);
    cfg.update('enable', !current, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      `Отслеживание изменений: ${!current ? 'Включено' : 'Выключено'}`
    );
  });

  // 14. Меню статусной строки
  const showRecentCmd = vscode.commands.registerCommand(
    'agentDiff.showRecentChanges',
    () => {
      statusBar.showMenu();
    }
  );

  // Слушатель изменения настроек VS Code
  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('agentDiff')) {
      const updatedConfig = getExtensionConfig();
      treeProvider.setTreeMode(updatedConfig.treeViewMode);
      decorationManager.setEnabled(updatedConfig.enableHighlight);
      statusBar.updateStatus();
    }
  });

  // 15. Поддержка файла-триггера завершения шага: .agent-inspector/.step-trigger
  const triggerPattern = new vscode.RelativePattern(
    workspaceFolder || vscode.Uri.file(workspaceRoot),
    '.agent-inspector/.step-trigger*'
  );
  const triggerWatcher = vscode.workspace.createFileSystemWatcher(triggerPattern);

  const handleStepTrigger = async (uri: vscode.Uri) => {
    try {
      let customTitle: string | undefined;
      if (fs.existsSync(uri.fsPath)) {
        try {
          const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
          if (content && content.trim().length > 0) {
            customTitle = content.trim();
          }
        } catch {
          // Игнорируем
        }
        await fs.promises.unlink(uri.fsPath).catch(() => {});
      }

      const cp = await historyManager.archiveCurrentTurn(customTitle);
      if (cp) {
        decoProvider.refresh();
        decorationManager.refreshAllVisibleEditors();
        updateBadges();
        statusBar.updateChanges([]);
        vscode.window.showInformationMessage(`Шаг зафиксирован через триггер: ${cp.title}`);
      }
    } catch (err) {
      console.error('[AgentInspector] Ошибка при обработке step-trigger:', err);
    }
  };

  triggerWatcher.onDidCreate(handleStepTrigger);
  triggerWatcher.onDidChange(handleStepTrigger);

  context.subscriptions.push(
    ignoreManager,
    historyManager,
    decorationManager,
    treeViewContainer,
    treeViewExplorer,
    decoSub,
    detector,
    statusBar,
    triggerWatcher,
    archiveCurrentCmd,
    openDiffCmd,
    openFileCmd,
    revertFileCmd,
    revertTurnCmd,
    revertAllCmd,
    clearAllCmd,
    clearHistoryCmd,
    toggleTreeModeCmd,
    toggleHighlightCmd,
    refreshTreeCmd,
    openSettingsCmd,
    toggleCmd,
    showRecentCmd,
    configWatcher
  );
}

export function deactivate() {}
