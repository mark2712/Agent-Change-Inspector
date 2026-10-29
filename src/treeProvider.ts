import * as vscode from 'vscode';
import * as path from 'path';
import { FileChangeInfo, TurnCheckpoint } from './types';
import { HistoryManager } from './historyManager';
import { getGitDiffSummary } from './gitHelper';

export type TreeNode = SectionTreeItem | TurnTreeItem | AgentTreeItem | PlaceholderTreeItem;

/**
 * Заголовок секции: "Текущий промпт" или "История шагов"
 */
export class SectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly sectionType: 'current' | 'history',
    public readonly count: number
  ) {
    super(
      sectionType === 'current' ? 'ТЕКУЩИЙ ПРОМПТ' : 'ИСТОРИЯ ШАГОВ',
      vscode.TreeItemCollapsibleState.Expanded
    );

    if (sectionType === 'current') {
      this.contextValue = 'agentSectionCurrent';
      this.description = count > 0 ? `(Активные правки: ${count})` : '(Ожидание правок)';
      this.iconPath = new vscode.ThemeIcon(
        count > 0 ? 'zap' : 'circle-outline',
        count > 0 ? new vscode.ThemeColor('charts.yellow') : undefined
      );
    } else {
      this.contextValue = 'agentSectionHistory';
      this.description = `(Архив: ${count})`;
      this.iconPath = new vscode.ThemeIcon(
        'history',
        new vscode.ThemeColor('charts.blue')
      );
    }
  }
}

/**
 * Элемент архивного шага (Промпта)
 */
export class TurnTreeItem extends vscode.TreeItem {
  constructor(public readonly checkpoint: TurnCheckpoint) {
    super(checkpoint.title, vscode.TreeItemCollapsibleState.Collapsed);

    this.contextValue = 'agentTurnItem';
    this.iconPath = new vscode.ThemeIcon('milestone');
    this.tooltip = `Шаг №${checkpoint.stepNumber}\nВремя: ${new Date(
      checkpoint.timestamp
    ).toLocaleTimeString()}\nФайлов: ${checkpoint.files.length}`;
  }
}

/**
 * Пустой плейсхолдер
 */
export class PlaceholderTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('dash');
    this.contextValue = 'agentPlaceholder';
  }
}

/**
 * Элемент файла
 */
export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly changeInfo?: FileChangeInfo,
    public readonly folderRelativePath?: string,
    public readonly isFolder: boolean = false,
    public readonly isArchiveFile: boolean = false
  ) {
    super(label, collapsibleState);

    if (isFolder) {
      this.contextValue = 'agentFolder';
      this.iconPath = vscode.ThemeIcon.Folder;
      this.tooltip = `Папка: ${folderRelativePath}`;
    } else if (changeInfo) {
      this.contextValue = changeInfo.isDeleted ? 'agentFileDeleted' : 'agentFile';
      this.resourceUri = changeInfo.uri;

      if (changeInfo.isDeleted) {
        this.iconPath = new vscode.ThemeIcon(
          'trash',
          new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
        );
        this.description = '🗑️ [Удален]';
        this.tooltip = `УДАЛЕН: ${changeInfo.relativeName}\nКликните для просмотра в Diff или отката`;
      } else {
        this.description = changeInfo.changedLinesSummary;
        this.tooltip = `${changeInfo.relativeName}\n${changeInfo.changedLinesSummary}\nВремя: ${new Date(
          changeInfo.timestamp
        ).toLocaleTimeString()}`;
      }

      this.command = {
        command: 'agentDiff.openDiff',
        title: 'Открыть Diff',
        arguments: [this],
      };
    }
  }
}

/**
 * Декоратор подсветки удаленных файлов красным
 */
export class AgentFileDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(private readonly getChangeInfo: (uri: vscode.Uri) => FileChangeInfo | undefined) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const change = this.getChangeInfo(uri);
    if (change?.isDeleted) {
      return {
        badge: 'D',
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        tooltip: 'Файл удален агентом',
        propagate: false,
      };
    }
    return undefined;
  }

  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }
}

/**
 * Провайдер дерева правок с разбивкой на ТЕКУЩИЙ ПРОМПТ и ИСТОРИЮ ШАГОВ
 */
export class AgentChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private isTreeMode = true;

  constructor(
    private readonly historyManager: HistoryManager,
    treeViewMode: 'tree' | 'flat' = 'tree'
  ) {
    this.isTreeMode = treeViewMode === 'tree';
    this.historyManager.onDidChange(() => this.refresh());
  }

  setTreeMode(mode: 'tree' | 'flat') {
    this.isTreeMode = mode === 'tree';
    this.refresh();
  }

  toggleTreeMode(): 'tree' | 'flat' {
    this.isTreeMode = !this.isTreeMode;
    this.refresh();
    return this.isTreeMode ? 'tree' : 'flat';
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChangeByUri(uri: vscode.Uri): FileChangeInfo | undefined {
    const current = this.historyManager.getCurrentChanges().find((c) => c.fsPath === uri.fsPath);
    if (current) {
      return current;
    }
    for (const h of this.historyManager.getHistory()) {
      const found = h.files.find((c) => c.fsPath === uri.fsPath);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * Сверка текущих активных правок с Git
   */
  async reconcileWithGit(workspaceRoot: string): Promise<void> {
    const current = this.historyManager.getCurrentChanges();
    for (const item of current) {
      const gitInfo = await getGitDiffSummary(item.fsPath, workspaceRoot);
      if (!gitInfo.hasChanges) {
        this.historyManager.removeCurrentFile(item.fsPath);
      }
    }
    this.refresh();
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    // 1. Корневой уровень: 2 секции
    if (!element) {
      const current = this.historyManager.getCurrentChanges();
      const history = this.historyManager.getHistory();

      return [
        new SectionTreeItem('current', current.length),
        new SectionTreeItem('history', history.length),
      ];
    }

    // 2. Внутри секции "ТЕКУЩИЙ ПРОМПТ"
    if (element instanceof SectionTreeItem && element.sectionType === 'current') {
      const current = this.historyManager.getCurrentChanges();
      if (current.length === 0) {
        return [new PlaceholderTreeItem('(Нет активных правок)')];
      }
      return this.renderFileList(current);
    }

    // 3. Внутри секции "ИСТОРИЯ ШАГОВ"
    if (element instanceof SectionTreeItem && element.sectionType === 'history') {
      const history = this.historyManager.getHistory();
      if (history.length === 0) {
        return [new PlaceholderTreeItem('(История пуста)')];
      }
      return history.map((cp) => new TurnTreeItem(cp));
    }

    // 4. Внутри архивного шага (TurnTreeItem)
    if (element instanceof TurnTreeItem) {
      return this.renderFileList(element.checkpoint.files, true);
    }

    // 5. Внутри подпапки (в режиме дерева)
    if (element instanceof AgentTreeItem && element.isFolder) {
      // Подпапка
      return [];
    }

    return [];
  }

  private renderFileList(files: FileChangeInfo[], isArchive: boolean = false): TreeNode[] {
    if (!this.isTreeMode) {
      return files.map(
        (c) =>
          new AgentTreeItem(
            path.basename(c.fsPath),
            vscode.TreeItemCollapsibleState.None,
            c,
            undefined,
            false,
            isArchive
          )
      );
    }

    // Древовидная группировка
    const folders = new Map<string, string>();
    const rootFiles: FileChangeInfo[] = [];

    for (const f of files) {
      const rel = f.relativeName.replace(/\\/g, '/');
      const slash = rel.indexOf('/');
      if (slash === -1) {
        rootFiles.push(f);
      } else {
        const topDir = rel.substring(0, slash);
        folders.set(topDir, topDir);
      }
    }

    const items: TreeNode[] = [];

    for (const [topDir] of folders.entries()) {
      // Для простоты и легкости вложенные файлы выводятся с относительным префиксом
      const inDir = files.filter((f) => f.relativeName.replace(/\\/g, '/').startsWith(topDir + '/'));
      for (const f of inDir) {
        items.push(
          new AgentTreeItem(
            f.relativeName,
            vscode.TreeItemCollapsibleState.None,
            f,
            undefined,
            false,
            isArchive
          )
        );
      }
    }

    for (const f of rootFiles) {
      items.push(
        new AgentTreeItem(
          path.basename(f.fsPath),
          vscode.TreeItemCollapsibleState.None,
          f,
          undefined,
          false,
          isArchive
        )
      );
    }

    return items;
  }
}
