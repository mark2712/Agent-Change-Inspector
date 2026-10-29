import * as vscode from 'vscode';
import * as path from 'path';
import { FileChangeInfo, TurnCheckpoint } from './types';
import { HistoryManager } from './historyManager';

export type TreeNode =
  | SectionTreeItem
  | TurnTreeItem
  | FolderTreeItem
  | AgentTreeItem
  | PlaceholderTreeItem;

/**
 * Заголовок секции: "Текущий шаг" или "История шагов"
 */
export class SectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly sectionType: 'current' | 'history',
    public readonly count: number
  ) {
    super(
      sectionType === 'current' ? 'ТЕКУЩИЙ ШАГ' : 'ИСТОРИЯ ШАГОВ',
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
      this.iconPath = new vscode.ThemeIcon('history', new vscode.ThemeColor('charts.blue'));
    }
  }
}

/**
 * Элемент архивного шага (Turn / Step)
 */
export class TurnTreeItem extends vscode.TreeItem {
  constructor(public readonly checkpoint: TurnCheckpoint) {
    super(checkpoint.title, vscode.TreeItemCollapsibleState.Collapsed);

    this.contextValue = 'agentTurnItem';
    this.iconPath = new vscode.ThemeIcon('milestone');
    this.tooltip = `Шаг №${checkpoint.stepNumber}\nПапка: .agent-inspector/snapshots/${checkpoint.folderName}\nФайлов: ${checkpoint.files.length}`;
  }
}

/**
 * Элемент виртуальной папки в режиме дерева
 */
export class FolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly folderName: string,
    public readonly fullFolderRelPath: string,
    public readonly files: FileChangeInfo[],
    public readonly isArchive: boolean = false,
    public readonly stepFolder?: string
  ) {
    super(folderName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'agentFolder';
    this.iconPath = vscode.ThemeIcon.Folder;
    this.tooltip = `Папка: ${fullFolderRelPath} (${files.length} файлов)`;
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
 * Элемент файла в дереве
 */
export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly changeInfo: FileChangeInfo,
    public readonly isArchive: boolean = false,
    public readonly stepFolder?: string
  ) {
    const fileName = path.basename(changeInfo.fsPath);
    super(fileName, vscode.TreeItemCollapsibleState.None);

    this.resourceUri = changeInfo.uri;
    this.description = changeInfo.changedLinesSummary;

    if (isArchive) {
      this.contextValue = changeInfo.isDeleted ? 'agentArchiveFileDeleted' : 'agentArchiveFile';
    } else {
      this.contextValue = changeInfo.isDeleted ? 'agentFileDeleted' : 'agentFile';
    }

    // Иконки статуса
    if (changeInfo.isDeleted) {
      this.iconPath = new vscode.ThemeIcon(
        'trash',
        new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
      );
      this.tooltip = `УДАЛЕН: ${changeInfo.relativeName}\nКликните для просмотра снимка или отката`;
    } else if (changeInfo.status === 'added' || changeInfo.isUntracked) {
      this.iconPath = new vscode.ThemeIcon(
        'diff-added',
        new vscode.ThemeColor('gitDecoration.addedResourceForeground')
      );
      this.tooltip = `СОЗДАН: ${changeInfo.relativeName}\n${changeInfo.changedLinesSummary}`;
    } else if (changeInfo.status === 'moved' || changeInfo.status === 'copied') {
      this.iconPath = new vscode.ThemeIcon(
        'move',
        new vscode.ThemeColor('charts.purple')
      );
      this.tooltip = `${changeInfo.status === 'moved' ? 'ПЕРЕМЕЩЕН' : 'СКОПИРОВАН'}: ${changeInfo.relativeName}`;
    } else {
      this.iconPath = new vscode.ThemeIcon(
        'edit',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
      );
      this.tooltip = `ИЗМЕНЕН: ${changeInfo.relativeName}\n${changeInfo.changedLinesSummary}`;
    }

    // Клик по элементу открывает файл / diff
    this.command = {
      command: 'agentDiff.openDiff',
      title: 'Открыть Diff',
      arguments: [this],
    };
  }
}

/**
 * Провайдер декораций файлов в проводнике VS Code (M, A, D)
 */
export class AgentFileDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(private readonly getChangeInfo: (uri: vscode.Uri) => FileChangeInfo | undefined) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const change = this.getChangeInfo(uri);
    if (!change) {
      return undefined;
    }

    if (change.isDeleted) {
      return {
        badge: 'D',
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        tooltip: 'Файл удален',
        propagate: false,
      };
    }

    if (change.status === 'added' || change.isUntracked) {
      return {
        badge: 'A',
        color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
        tooltip: 'Новый файл',
        propagate: false,
      };
    }

    if (change.status === 'moved' || change.status === 'copied') {
      return {
        badge: change.status === 'moved' ? 'R' : 'C',
        color: new vscode.ThemeColor('charts.purple'),
        tooltip: change.status === 'moved' ? 'Перемещен' : 'Скопирован',
        propagate: false,
      };
    }

    return {
      badge: 'M',
      color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
      tooltip: 'Изменен',
      propagate: false,
    };
  }

  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }
}

/**
 * Провайдер дерева правок:
 * 1. ТЕКУЩИЙ ШАГ (активные изменения, которые будут зафиксированы по кнопке)
 * 2. ИСТОРИЯ ШАГОВ (архив в .agent-inspector/snapshots и .agent-inspector/tree)
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

  getActiveChangeByUri(uri: vscode.Uri): FileChangeInfo | undefined {
    return this.historyManager.getCurrentChanges().find((c) => c.fsPath === uri.fsPath);
  }

  getChangeByUri(uri: vscode.Uri): FileChangeInfo | undefined {
    const current = this.getActiveChangeByUri(uri);
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

    // 2. Внутри секции "ТЕКУЩИЙ ШАГ"
    if (element instanceof SectionTreeItem && element.sectionType === 'current') {
      const current = this.historyManager.getCurrentChanges();
      if (current.length === 0) {
        return [new PlaceholderTreeItem('(Нет активных правок)')];
      }
      return this.renderFileList(current, '', false, this.historyManager.getActiveFolderName());
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
      return this.renderFileList(
        element.checkpoint.files,
        '',
        true,
        element.checkpoint.folderName
      );
    }

    // 5. Внутри папки (FolderTreeItem)
    if (element instanceof FolderTreeItem) {
      return this.renderFileList(
        element.files,
        element.fullFolderRelPath,
        element.isArchive,
        element.stepFolder
      );
    }

    return [];
  }

  /**
   * Построение иерархического дерева папок или плоского списка
   */
  private renderFileList(
    files: FileChangeInfo[],
    baseDir: string = '',
    isArchive: boolean = false,
    stepFolder?: string
  ): TreeNode[] {
    // В плоском режиме — выводим все файлы с полными путями
    if (!this.isTreeMode) {
      return files.map((c) => {
        const item = new AgentTreeItem(c, isArchive, stepFolder);
        item.label = c.relativeName;
        return item;
      });
    }

    // В древовидном режиме — группируем по непосредственным подпапкам и файлам
    const prefix = baseDir ? (baseDir.endsWith('/') ? baseDir : baseDir + '/') : '';
    const relevantFiles = files.filter((f) => {
      const rel = f.relativeName.replace(/\\/g, '/');
      return prefix ? rel.startsWith(prefix) : true;
    });

    const folderMap = new Map<string, FileChangeInfo[]>();
    const directFiles: FileChangeInfo[] = [];

    for (const f of relevantFiles) {
      const rel = f.relativeName.replace(/\\/g, '/');
      const tail = prefix ? rel.substring(prefix.length) : rel;
      const slashIdx = tail.indexOf('/');

      if (slashIdx === -1) {
        // Файл лежит непосредственно в текущей папке
        directFiles.push(f);
      } else {
        // Файл в подпапке
        const folderName = tail.substring(0, slashIdx);
        if (!folderMap.has(folderName)) {
          folderMap.set(folderName, []);
        }
        folderMap.get(folderName)!.push(f);
      }
    }

    const items: TreeNode[] = [];

    // Сначала папки (по алфавиту)
    const sortedFolders = Array.from(folderMap.keys()).sort();
    for (const folderName of sortedFolders) {
      const subFiles = folderMap.get(folderName)!;
      const fullSubPath = prefix ? prefix + folderName : folderName;
      items.push(
        new FolderTreeItem(folderName, fullSubPath, subFiles, isArchive, stepFolder)
      );
    }

    // Затем файлы (по алфавиту)
    directFiles.sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)));
    for (const f of directFiles) {
      items.push(new AgentTreeItem(f, isArchive, stepFolder));
    }

    return items;
  }
}
