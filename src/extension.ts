import * as vscode from 'vscode';
import { ExtensionConfig, FileChangeInfo } from './types';
import { ChangeDetector } from './detector';
import { DiffPresenter } from './diffPresenter';
import { StatusBarManager } from './statusBar';
import {
  AgentChangesTreeProvider,
  AgentTreeItem,
  AgentFileDecorationProvider,
} from './treeProvider';
import { IgnoreManager } from './ignoreManager';
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
    showNotification: cfg.get<boolean>('showNotification', false),
    treeViewMode: cfg.get<'tree' | 'flat'>('treeViewMode', 'tree'),
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
      '**/tmp/**',
    ]),
    debounceMs: cfg.get<number>('debounceMs', 400),
  };
}

export function activate(context: vscode.Context) {
  const config = getExtensionConfig();
  const ignoreManager = new IgnoreManager();
  const presenter = new DiffPresenter(getExtensionConfig);
  const treeProvider = new AgentChangesTreeProvider(config.treeViewMode);

  // Провайдер подсветки удаленных файлов красным цветом
  const decoProvider = new AgentFileDecorationProvider((uri) =>
    treeProvider.getChangeByUri(uri)
  );
  const decoSub = vscode.window.registerFileDecorationProvider(decoProvider);

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
    const count = treeProvider.getAllChanges().length;
    const badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} измененных файлов`,
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

  // Детектор внешних изменений с учетом .agentignore
  const detector = new ChangeDetector(getExtensionConfig, ignoreManager, async (changes) => {
    if (changes.length > 0) {
      treeProvider.addOrUpdateChanges(changes);
      decoProvider.refresh();
      updateBadges();
      statusBar.updateChanges(changes);
      await presenter.presentChanges(changes);
    }
  });

  // Вспомогательная функция для извлечения информации о файле из аргументов команды
  const extractChangeInfo = (item?: AgentTreeItem | FileChangeInfo): FileChangeInfo | undefined => {
    if (!item) {
      const all = treeProvider.getAllChanges();
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

  const openDiffCmd = vscode.commands.registerCommand(
    'agentDiff.openDiff',
    async (item?: AgentTreeItem | FileChangeInfo) => {
      const change = extractChangeInfo(item);
      if (change) {
        await presenter.openDiffTab(change);
      }
    }
  );

  const openFileCmd = vscode.commands.registerCommand(
    'agentDiff.openFile',
    async (item?: AgentTreeItem | FileChangeInfo) => {
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
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

      const ok = await revertGitFile(change.fsPath, workspaceRoot);
      if (ok) {
        treeProvider.removeChange(change.fsPath);
        decoProvider.refresh();
        updateBadges();
        vscode.window.showInformationMessage(
          `Файл ${change.relativeName} откачен / восстановлен.`
        );
      } else {
        vscode.window.showErrorMessage(`Не удалось откатить файл ${change.relativeName}.`);
      }
    }
  );

  const refreshTreeCmd = vscode.commands.registerCommand('agentDiff.refreshTree', () => {
    treeProvider.refresh();
    decoProvider.refresh();
  });

  const toggleTreeModeCmd = vscode.commands.registerCommand('agentDiff.toggleTreeMode', () => {
    const newMode = treeProvider.toggleTreeMode();
    vscode.window.showInformationMessage(
      `Режим проводника правок: ${newMode === 'tree' ? 'Дерево папок' : 'Плоский список'}`
    );
  });

  const clearAllCmd = vscode.commands.registerCommand('agentDiff.clearAllChanges', () => {
    treeProvider.clear();
    decoProvider.refresh();
    updateBadges();
    vscode.window.showInformationMessage('Список измененных файлов очищен.');
  });

  const revertAllCmd = vscode.commands.registerCommand('agentDiff.revertAllChanges', async () => {
    const all = treeProvider.getAllChanges();
    if (all.length === 0) {
      vscode.window.showInformationMessage('Нет файлов для отката.');
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Откатить ВСЕ (${all.length}) измененные / удаленные файлы?`,
      'Да, откатить все',
      'Отмена'
    );

    if (answer === 'Да, откатить все') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

      for (const change of all) {
        await revertGitFile(change.fsPath, workspaceRoot);
      }

      treeProvider.clear();
      decoProvider.refresh();
      updateBadges();
      vscode.window.showInformationMessage('Все измененные файлы успешно откатаны.');
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
      statusBar.updateStatus();
    }
  });

  context.subscriptions.push(
    ignoreManager,
    treeViewContainer,
    treeViewExplorer,
    decoSub,
    detector,
    statusBar,
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
